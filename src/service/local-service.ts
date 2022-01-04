import { DriverStats, LocalDriver, NodeStatus, RemoteDriver } from "../schemas";
import { LocalSession } from "../session/local-session";
import * as si from "systeminformation";
import axios from "axios";
import { DEFAULT_HOST_IP_PLACEHOLDER } from "../constants";
import { logException, logMessage } from "../utils";
import { Request } from "koa";
import { newHttpError } from "../error";
import { exec } from "child_process";
import { DriverService, getMatchCriteria, isCriteriaMatch } from "./services";
import { sumBy, } from "lodash";

export class LocalDriverService extends DriverService<LocalDriver, LocalSession> {

  public sessionsUpdateListeners: (() => any)[] = [];

  get cumulativeSessionsCount(): number {
    return sumBy(this.driversStats, driverStats => driverStats.stats.total);
  }

  get isReadyToReboot(): boolean {
    if (!this.config.autoRebootThreshold) return false;
    return this.cumulativeSessionsCount >= this.config.autoRebootThreshold && !this.activeSessionsCount;
  }

  get driversStats(): DriverStats[] {
    return this.drivers.map(driver => ({
      ...driver,
      sessions: [...this.getSessionsByDriver(driver)!].map(session => session.toSessionDto()),
      stats: this.getStatsByDriver(driver),
    }));
  }

  async getStatuses(): Promise<NodeStatus[]> {
    return [{
      configuration: { ...this.config, localDrivers: [] },
      systemInfo: {
        os: await si.osInfo(),
        system: await si.system(),
        networkInterfaces: (await si.networkInterfaces()).filter(net => (net.ip4 || net.ip6) && !net.internal),
      },
      drivers: this.driversStats,
    }];
  }

  private async register() {
    await axios.request({
      method: 'POST',
      baseURL: this.config.registerTo,
      url: '/register',
      data: {
        url: this.config.registerAs || `http://${DEFAULT_HOST_IP_PLACEHOLDER}:${this.config.port}/wd/hub`,
      }
    }).catch(logException);
  }

  init() {
    logMessage(`working on local mode`);
    // kill session process on exit
    ['SIGTERM', 'SIGINT'].forEach(signal =>
      process.on(signal, () => {
        for (const session of this.sessions) {
          session.kill();
        }
        process.exit();
      })
    );
    // register to remote service
    if (this.config.registerTo) {
      logMessage(`register to ${this.config.registerTo}`);

      this.register();
      setInterval(async () => {
        this.register();
      }, 1e3 * this.config.registerTimeout / 3);
    }
  }

  async registerDriver(driver: RemoteDriver) {
    throw Error("This node is running on local mode.");
  }

  async getAvailableDrivers() {
    if (this.activeSessionsCount >= this.config.maxSessions) {
      return [];
    }
    if (this.isReadyToReboot) {
      return [];
    }
    return this.drivers.filter(driver => this.getSessionsByDriver(driver)!.size < driver.maxSessions);
  }

  async createSession(request: Request) {
    const criteria = getMatchCriteria(request.body);
    const candidates = (await this.getAvailableDrivers())
      .filter(driver => isCriteriaMatch(driver, criteria));

    if (!candidates.length) {
      throw newHttpError(404, `No Drivers Available!`)
    }
    const driver = candidates[0];
    const session = new LocalSession(
      driver.browserName,
      driver.webdriverPath,
      driver.webdriverArgs! as any,
      driver.webdriverEnvs,
      driver.defaultCapabilities
    );
    const stats = this.getStatsByDriver(driver);
    stats.total += 1;
    try {
      return await this.startSession(session, request, driver);
    } catch (e) {
      stats.failed += 1;
      throw e;
    }
  }

  onSessionDelete() {
    if (this.isReadyToReboot) {
      console.log("start to reboot!", "cumulativeSessionsCount>>", this.cumulativeSessionsCount, ",autoRebootThreshold>>", this.config.autoRebootThreshold);
      this.reboot();
    }
  }

  reboot() {
    const ps = exec(this.config.autoRebootCommand);
    ps.stdout?.pipe(process.stdout);
    ps.stderr?.pipe(process.stderr);
  }
}
