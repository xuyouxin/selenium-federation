import {
  Configuration,
  DriverMatchCriteria,
  LocalDriver,
  NodeStatus,
  RemoteDriver,
  SessionPathParams,
  SessionStats,
} from "../schemas";
import { Session } from "../session/sessions";
import { Request } from "koa";
import { Watchdog } from "../watchdog";
import { AxiosResponse } from "axios";
import { newHttpError } from "../error";


export abstract class DriverService<D extends object, S extends Session>{
  private sessionsMap: Map<string, S> = new Map();
  private sessionDriverMap: WeakMap<S, D> = new WeakMap();
  private sessionWatchdogMap: WeakMap<S, Watchdog> = new WeakMap();
  private driverSessionsMap: WeakMap<D, Set<S>> = new WeakMap();
  private sessionStatsMap: WeakMap<D, SessionStats> = new WeakMap();

  constructor(
    protected readonly drivers: D[],
    protected readonly config: Configuration,
  ) {
    for (const driver of this.drivers) {
      this.driverSessionsMap.set(driver, new Set());
      this.sessionStatsMap.set(driver, { total: 0, failed: 0 });
    }
  }

  get activeSessionsCount(): number {
    return this.sessionsMap.size;
  }

  addDriver(driver: D) {
    this.drivers.push(driver);
    this.driverSessionsMap.set(driver, new Set());
  }

  addSession(session: S, driver: D, watchdog: Watchdog) {
    this.sessionsMap.set(session.id!, session);
    this.driverSessionsMap.get(driver)!.add(session);
    this.sessionDriverMap.set(session, driver);
    this.sessionWatchdogMap.set(session, watchdog);
  }

  removeSession(session: S) {
    this.sessionsMap.delete(session.id!);
    const driver = this.sessionDriverMap.get(session);
    this.driverSessionsMap.get(driver!)!.delete(session);
    this.sessionDriverMap.delete(session);
    this.sessionWatchdogMap.delete(session);
  }

  get sessions() {
    return this.sessionsMap.values();
  }

  getSession(id: string) {
    const session = this.sessionsMap.get(id);
    if (!session) {
      throw newHttpError(404, `session ${id} is not found.`)
    }
    return session;
  }

  getWatchdogBySession(session: S) {
    return this.sessionWatchdogMap.get(session);
  }

  getSessionsByDriver(driver: D) {
    return this.driverSessionsMap.get(driver);
  }

  getStatsByDriver(driver: D) {
    return this.sessionStatsMap.get(driver)!;
  }

  async startSession(session: S, request: Request, driver: D) {
    const response = await session.start(request);
    const watchdog = new Watchdog(async () => {
      // if it is remote mode, it need send a request to remote machine to delete the session
      // if (this.config.registerTo) {
      //   request.method = "DELETE";
      //   request.body = undefined;
      //   request.query = undefined;
      //   await session.forward(request, "");
      // }
      this.deleteSession(session.id!);
    }, this.config.browserIdleTimeout);
    this.addSession(session, driver, watchdog);
    return response;
  }

  async deleteSession(sessionId: string) {
    const session = this.getSession(sessionId);
    await session.stop();
    this.getWatchdogBySession(session)?.stop();
    this.removeSession(session);
    this.onSessionDelete();
  }

  async forward(request: Request, params: SessionPathParams) {
    const sessionId = params.sessionId;
    const session = this.getSession(sessionId);
    this.getWatchdogBySession(session)?.feed();
    return await session.forward(request, params.suffix);
  }

  onSessionDelete() {}

  abstract init(): void;
  abstract registerDriver(driver: RemoteDriver): Promise<void>;
  abstract getAvailableDrivers(): Promise<LocalDriver[]>;
  abstract createSession(request: Request): Promise<AxiosResponse>;
  abstract getStatuses(): Promise<NodeStatus[]>;
}

export const isCriteriaMatch = (driver: LocalDriver, criteria: DriverMatchCriteria): boolean =>
  (criteria.browserName? driver.browserName === criteria.browserName: true) &&
  (criteria.tags.every(tag => driver.tags!.includes(tag as any))) &&
  (criteria.platformName ? driver.platformName === criteria.platformName : true) &&
  (criteria.uuid ? driver.uuid === criteria.uuid : true) &&
  (criteria.browserVersion ? driver.browserVersion === criteria.browserVersion : true)

export const getMatchCriteria = (requestBody: any): DriverMatchCriteria => {
  const capabilities = requestBody?.desiredCapabilities;
  const browserName = capabilities?.browserName;
  const browserVersion = capabilities?.browserVersion;
  const platformName  = capabilities?.platformName;
  const extOptions = capabilities?.extOptions;
  const tags = extOptions?.tags || [];
  const uuid = extOptions?.uuid;
  return { browserName, browserVersion, platformName, tags, uuid };
}
