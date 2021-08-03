import { config } from "./config";
import { Driver } from "./schemas";
import { DriverService } from "./service/services";
import { Session } from "./session/sessions";
import { LocalDriverService } from "./service/local-service";
import { RemoteDriverService } from "./service/remote-service";

let driverService: DriverService<Driver, Session>

if (config.localDrivers.length > 0) {
  driverService = new LocalDriverService(config.localDrivers, config);
} else {
  driverService = new RemoteDriverService([], config);
}

driverService.init();

export { driverService };
