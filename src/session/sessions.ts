import { AxiosResponse } from "axios";
import { Request } from "koa";
import { cloneDeep, defaultsDeep, } from "lodash";
import { SessionDto } from "../schemas";


export abstract class Session {
  public id?: string;
  public option?: any;
  public abstract start(request: Request): Promise<AxiosResponse>;
  public abstract stop(): Promise<void>;
  public abstract forward(request: Request, path?: string): Promise<AxiosResponse>;

  toSessionDto(): SessionDto {
    return { id: this.id!, option: this.option };
  }
}

export const sanitizeCreateSessionRequest = (caps: any, defaultCaps?: any) => {
  const _caps = cloneDeep(caps);
  // some drivers are sensitive to invalid fields and values
  // work around by just removing those fields
  delete _caps?.desiredCapabilities?.extOptions;
  delete _caps?.capabilities?.alwaysMatch?.extOptions;
  delete _caps?.desiredCapabilities?.browserVersion;
  delete _caps?.capabilities?.alwaysMatch?.browserVersion;
  // merge with default capabilities
  return defaultCaps ? defaultsDeep(_caps, {
    capabilities: {
      alwaysMatch: defaultCaps,
    },
    desiredCapabilities: defaultCaps,
  }) : _caps;
}

export const getEnvsFromRequest = (requestBody: any) => {
  const caps = requestBody.desiredCapabilities || requestBody.capabilities?.alwaysMatch;
  return caps?.extOptions?.envs || {};
}
