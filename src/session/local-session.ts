import { ChildProcess, exec, execSync, spawn } from "child_process";
import { logException, retry, Semaphore } from "../utils";
import getPort from "get-port";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { Request } from "koa";
import { isEmpty, isNil, } from "lodash";
import Bluebird from "bluebird";
import { newHttpError } from "../error";
import { getEnvsFromRequest, sanitizeCreateSessionRequest, Session } from "./sessions";

export class LocalSession extends Session {

  private port?: number;
  private childProcess?: ChildProcess;
  private semaphore: Semaphore;

  get baseUrl() {
    return `http://localhost:${this.port}/session`;
  }

  constructor(
    private browserName: string,
    private webdriverPath: string,
    private args: string[],
    private envs: any,
    private defaultCapabilities: any,
  ) {
    super();
    this.semaphore = new Semaphore(1);
  }

  public async start(request: Request) {
    try {
      return await this._start(request);
    } catch (e) {
      this.kill();
      throw newHttpError(500, e.message, { stack: e.stack });
    }
  }

  public async stop() {
    await Bluebird.delay(500);
    this.kill();
  }

  public async forward(request: Request, path?: string) {
    const url = `/${this.id}${isNil(path) ? '' : ('/' + path)}`;
    try {
      await this.semaphore.wait();
      if (path == "auto-cmd") {
        const { script } = request.body;
        return await this.localExecute(script);
      }

      return await axios.request(this.sanitizeRequest({
        baseURL: this.baseUrl,
        url,
        method: request.method as any,
        data: request.body,
        headers: request.headers,
        params: request.query,
        timeout: 120e3,
      }));
    } catch (e) {
      if (!e.response) throw newHttpError(500, e.message, { stack: e.stack });
      return e.response;
    } finally {
      this.semaphore.signal();
    }
  }

  public async localExecute(cmd: string) {
    return new Promise<{ stdout: string, stderr: string }>(function (resolve, reject) {
      // maxBuffer is specified to avoid ERR_CHILD_PROCESS_STDIO_MAXBUFFER
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout: string, stderr: string) => {
        resolve({ stdout, stderr });
      });
    }).then(res => {
      if (res.stderr) {
        return {
          success: false,
          error: res.stderr.toString()
        }
      } else {
        return {
          success: true,
          result: res.stdout.trim()
        }
      }
    });
  }

  private async _start(request: Request) {
    this.port = await getPort();
    this.childProcess = spawn(this.webdriverPath, [...this.args, `--port=${this.port}`],
      {
        stdio: 'inherit', detached: !this.isWindows, windowsHide: this.isWindows,
        env: { ...process.env, ...this.envs, ...getEnvsFromRequest(request.body) }
      });
    await Bluebird.delay(200); // wait for process ready to serve
    const requestData = sanitizeCreateSessionRequest(request.body, this.defaultCapabilities);
    const response = await retry<AxiosResponse>(
      () => axios.request({ method: 'POST', url: this.baseUrl, data: requestData, timeout: 5e3 }),
      {
        max: 5,
        interval: 1e3,
        condition: (e) => !e.response,
      });
    this.id = response?.data?.sessionId || response?.data?.value?.sessionId;
    this.option = requestData;
    if (!this.id) {
      throw newHttpError(500, "Invalid response!", response);
    }
    return response!;
  }

  public kill() {
    if (this.childProcess && !this.childProcess.killed) {
      try {
        if (this.isWindows) {
          execSync(`taskkill /T /F /PID ${this.childProcess.pid}`);
        } else {
          process.kill(-this.childProcess.pid);
        }
      } catch (e) {
        logException(e);
      }
    }
  }

  private get isWindows() {
    return "win32" === process.platform;
  }

  /**
   * sanitize 消毒
   * @param request
   */
  private sanitizeRequest(request: AxiosRequestConfig) {
    const headers = { ...request.headers };
    delete headers.host;
    request.headers = headers;

    const method = request.method?.toUpperCase();
    if ('safari' == this.browserName && ('GET' === method || 'DELETE' == method) && isEmpty(request.data)) {
      // FIX: https://github.com/webdriverio/webdriverio/issues/3187
      // Request failed with status 400 due to Response has empty body on safari
      delete request.data;
      delete request.headers?.['content-length'];
    }
    return request;
  }
}
