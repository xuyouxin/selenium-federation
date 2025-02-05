import { AxiosResponse } from "axios";
import { Context } from "koa";
import { driverService } from "./runtime";
import { RemoteDriver, SessionPathParams } from "./schemas";
import { localExecute, logMessage, Semaphore } from "./utils";
import { DEFAULT_HOST_IP_PLACEHOLDER } from "./constants";
import { newHttpError } from "./error";

export type RequestHandler = (ctx: Context, next: () => Promise<any>) => Promise<void>;

const createSessionLock = new Semaphore(1);

export const handleRegisterRequest: RequestHandler = async (ctx, next) => {
  const driver: RemoteDriver = {
    registerAt: Date.now(),
    ...ctx.request.body,
  };
  // using request ip as default host
  driver.url = driver.url.replace(DEFAULT_HOST_IP_PLACEHOLDER, ctx.request.ip);
  await driverService.registerDriver(driver);
  ctx.status = 201;
  next();
}

export const handleCreateSessionRequest: RequestHandler = async (ctx, next) => {
  logRequest(ctx);
  try {
    await createSessionLock.wait();
    const response = await driverService.createSession(ctx.request);
    setResponse(ctx, response);
  } finally {
    createSessionLock.signal();
  }
  next();
}

export const handleSessionRequest: RequestHandler = async (ctx, next) => {
  const params = sanitizeSessionParams(ctx.params);
  const response = await driverService.forward(ctx.request, params);
  setResponse(ctx, response);
  next();

  if ('DELETE' === ctx.method.toUpperCase() && !params.suffix) {
    console.log('delete session>> ', params.sessionId);
    await driverService.deleteSession(params.sessionId);
  }
}

export const handleAutocmd: RequestHandler = async (ctx, next) => {
  const { script } = ctx.request.body;
  const response =  await localExecute(script);
  setResponse(ctx, response);
  next();
}

export const handleQueryAvailableDriversRequest: RequestHandler = async (ctx, next) => {
  ctx.body = JSON.stringify(await driverService.getAvailableDrivers());
  ctx.status = 200;
  next();
}

export const handleGetStatusesRequest: RequestHandler = async (ctx, next) => {
  ctx.body = JSON.stringify(await driverService.getStatuses());
  ctx.status = 200;
  next();
}

const sanitizeSessionParams = (obj: any): SessionPathParams => {
  if (!obj.sessionId) throw newHttpError(400, `sessionId is required in path params.`, obj)
  return { sessionId: obj.sessionId, suffix: obj[0] };
}

const setResponse = (ctx: Context, response: AxiosResponse) => {
  const data = response?.data;
  ctx.set(response?.headers || {});
  ctx.body = data ? JSON.stringify(data) : data;
  ctx.status = response?.status || 500;
}

const logRequest = (ctx: Context) => {
  logMessage(JSON.stringify({ ...ctx.request.toJSON(), body: ctx.request.body }, null, 2));
}
