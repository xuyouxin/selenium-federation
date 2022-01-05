import { LocalDriver, localDriverSchema, NodeStatus, RemoteDriver } from "../schemas";
import { RemoteSession } from "../session/remote-session";
import { logException, logMessage, Semaphore } from "../utils";
import axios from "axios";
import { DriverService, getMatchCriteria, isCriteriaMatch } from "./services";
import { Request } from "koa";
import { newHttpError } from "../error";
import Bluebird from "bluebird";
import { flatten, minBy, shuffle, } from "lodash";

export class RemoteDriverService extends DriverService<RemoteDriver, RemoteSession> {

  private semaphore: Semaphore;

  init() {
    this.semaphore = new Semaphore(1);
    logMessage(`working on remote mode`);
  }

  private async checkHealth(driver: RemoteDriver) {
    return axios.request({
      method: 'GET',
      baseURL: driver.url,
      url: '/available-drivers',
      timeout: 5e3,
    });
  }

  async registerDriver(driver: RemoteDriver) {
    await this.checkHealth(driver);
    const found = this.drivers.find(d => d.url === driver.url);
    if (found) {
      found.registerAt = Date.now()
    } else {
      logMessage(`register new remote driver: ${driver.url}`);
      this.addDriver(driver);
    }
  }

  async getStatuses(): Promise<NodeStatus[]> {
    const statuses = await Bluebird.map(this.activeRemoteDriver, async remoteDriver => {
      const response = await axios.request<NodeStatus[]>({
        method: 'GET',
        baseURL: remoteDriver.url,
        url: '/statuses',
        timeout: 5e3,
      }).catch(logException);

      if (!response) return [];
      return response.data.map(opts => ({ ...opts, remoteUrl: remoteDriver.url }));
    }, { concurrency: 8 })
    return flatten(statuses);
  }

  async getAvailableDrivers() {
    return this.getCandidates().then(candidates => candidates.map(([rd, ld]) => ld));
  }

  async createSession(request: Request) {
    const criteria = getMatchCriteria(request.body);
    const candidates: [RemoteDriver, LocalDriver][] = (await this.getCandidates())
      .filter(([remoteDriver, localDriver]) => isCriteriaMatch(localDriver, criteria));

    if (!candidates.length) {
      throw newHttpError(404, `No Drivers Available!`)
    }
    await this.semaphore.wait();
    const remoteDriver = this.getTheLeastBusyDriver(candidates);
    this.semaphore.signal();
    const session = new RemoteSession(remoteDriver.url);
    return this.startSession(session, request, remoteDriver);
  }

  private getTheLeastBusyDriver(candidates: [RemoteDriver, LocalDriver][]): RemoteDriver {
    console.log('candidates length>>', candidates.length);

    return minBy(candidates, ([rd, ld]) => {
      const size = this.getSessionsByDriver(rd)?.size || Number.MIN_VALUE
      console.log('candidate info>>', rd.url, size);
      return size;
    })![0];
  }

  private async getCandidates(): Promise<[RemoteDriver, LocalDriver][]> {
    const packedCandidates: [RemoteDriver, LocalDriver][][] = await Bluebird.map(this.activeRemoteDriver, async remoteDriver => {
      // 返回的数据格式 符合 LocalDriver[]的规格
      const response = await axios.request<LocalDriver[]>({
        method: 'GET',
        baseURL: remoteDriver.url,
        url: '/available-drivers',
        timeout: 5e3,
      }).catch(logException);

      if (!response) return [];
      return response.data
        .filter(localDriver => localDriverSchema.isValidSync(localDriver))
        .map(localDriver => [remoteDriver, localDriver]);
    }, { concurrency: 8 });
    return flatten(packedCandidates);
  }

  private get activeRemoteDriver() {
    // const now = Date.now();
    // return this.drivers.filter(driver => driver.registerAt + 1e3 * this.config.registerTimeout > now);
    return this.drivers;
  }
}
