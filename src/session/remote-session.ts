import axios from "axios";
import { Request } from "koa";
import { isNil, } from "lodash";
import { newHttpError } from "../error";
import { Session } from "./sessions";

export class RemoteSession extends Session {

  constructor(private baseUrl: string) {
    super();
  }

  public async start(request: Request) {
    const response = await axios.request({
      method: 'POST',
      baseURL: this.baseUrl,
      url: '/session',
      data: request.body,
      timeout: 60e3,
    });
    this.id = response?.data?.sessionId || response?.data?.value.sessionId;
    if (!response || !this.id) {
      throw newHttpError(500, "Invalid response!", response);
    }
    return response;
  }

  public async stop() {
  }

  public async forward(request: Request, path?: string) {
    const url = `/session/${this.id}${isNil(path) ? '' : ('/' + path)}`;
    console.log(`${request.method.toUpperCase()} ${url}`);
    try {
      return await axios.request({
        baseURL: this.baseUrl,
        url,
        method: request.method as any,
        data: request.body,
        headers: request.headers,
        params: request.query,
        timeout: 120e3,
      });
    } catch (e) {
      if (!e.response) throw newHttpError(500, e.message, { stack: e.stack });
      return e.response;
    }
  }
}
