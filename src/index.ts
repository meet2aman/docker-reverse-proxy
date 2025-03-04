import express from "express";
import http from "http";
import Docker from "dockerode";
import { Request, Response } from "express";
import redisClient from "./lib/client";
import httpProxy from "http-proxy";

// new docker instance
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// const db = new Map();

// httpProxy server
const proxy = httpProxy.createProxy({});

// docker configurations
docker.getEvents(function (err, stream) {
  if (err) {
    console.log(`Error in getting events: ${err}`);
    return;
  }
  if (!stream) {
    console.error("❌ Stream is undefined");
    return;
  }
  try {
    stream.on("data", async (chunk) => {
      if (!chunk) {
        console.log(`no chunks: ${chunk}`);
      }
      const event = JSON.parse(chunk.toString());
      // console.log("events:::::", event);
      if (event.Type === "container" && event.Action === "start") {
        // console.log(`inside of strean.on`);
        const container = docker.getContainer(event.id);
        const containerInfo = await container.inspect();

        // console.log("containerINfo:::", containerInfo);

        const containerName = containerInfo.Name.substring(1);
        const ipAddress = containerInfo.NetworkSettings.IPAddress;

        const exposedPort = Object.keys(containerInfo.Config.ExposedPorts);
        // console.log("Infosss::::", containerName, ipAddress, exposedPort);
        let defaultPort = null;

        if (exposedPort && exposedPort.length > 0) {
          const [port, type] = exposedPort[0].split("/");
          if (type === "tcp") {
            defaultPort = port;
          }
        }
        // const redisClient = await connectToRedis();
        // db.set(containerName, { containerName, ipAddress, defaultPort });
        await redisClient.hset(containerName, {
          containerName,
          ipAddress,
          defaultPort: defaultPort || "",
        });

        console.log(
          `Registering  ${containerName}.localhost ---> http://${ipAddress}:${defaultPort}`
        );

        //
      }
    });
  } catch (error) {
    console.error("❌ Error processing Docker event:", error);
  }
});

// express reverse-proxy server
const reverseProxyApp = express();

reverseProxyApp.use(async (req, res): Promise<any> => {
  const hostName = req.hostname;

  const subDomain = hostName.split(".")[0];

  // const obj = Object.fromEntries(db.entries());
  // const client = await connectToRedis();
  // if (!db.has(subDomain)) return res.status(404).end("subdomain not found ");
  if (!subDomain) {
    return res.status(400).json({ error: "Invalid subdomain" });
  }
  if (!subDomain) {
    return res.status(400).json({ error: "Invalid subdomain" });
  }
  const containerData = await redisClient.hgetall(subDomain);

  // const containerData = db.get(subDomain);

  if (!containerData || Object.keys(containerData).length === 0) {
    return res.status(404).json({ error: "Subdomain not found" });
  }

  const { ipAddress, defaultPort } = containerData;
  if (!ipAddress || !defaultPort) {
    res.status(500).end("Invalid container data");
  }

  const target = `http://${ipAddress}:${defaultPort}`;

  console.log(`Forwording ${hostName} -> ${target}`);

  proxy.web(req, res, { target, changeOrigin: true, ws: true });
});
// http server
const reverseProxy = http.createServer(reverseProxyApp);

reverseProxy.on("upgrade", async (req, socket, head) => {
  const hostName = req.headers.host;

  const subDomain = hostName?.split(".")[0];
  if (!subDomain) {
    console.log("No subdomain");
    return;
  }
  const containerData = await redisClient.hgetall(subDomain);

  // const containerData = db.get(subDomain);

  if (!containerData || Object.keys(containerData).length === 0) {
    console.log({ error: "Subdomain not found" });
    return;
  }

  const { ipAddress, defaultPort } = containerData;
  if (!ipAddress || !defaultPort) {
    console.log({ error: "Ip and Port not found" });
  }

  const target = `http://${ipAddress}:${defaultPort}`;

  console.log(`Forwording ${hostName} -> ${target}`);

  return proxy.ws(req, socket, head, {
    target: target,
    ws: true,
  });
});

// express management server
const managementAPI = express();

// expresss middleware
managementAPI.use(express.json());

// management api express server post route
managementAPI.post("/containers", async (req: Request, res: Response) => {
  const { image, tag = "latest" } = await req.body;
  let imageAlreadyExists = false;

  // checking the all docker images present on machine
  const images = await docker.listImages();

  for (const systemIMG of images) {
    for (const systemTag of systemIMG.RepoTags!) {
      if (systemTag === `${image}:${tag}`) {
        imageAlreadyExists = true;
        break;
      }
    }
    if (imageAlreadyExists) break;
  }

  // if image not present then pull it from repository
  if (!imageAlreadyExists) {
    console.log(`Pulling Image: ${image}:${tag}`);
    await docker.pull(`${image}:${tag}`);
  }

  const container = await docker.createContainer({
    Image: `${image}:${tag}`,
    Tty: false,
    HostConfig: {
      AutoRemove: true,
    },
  });

  await container.start();

  res.json({
    status: "success",
    container: `${(await container.inspect()).Name}.localhost`,
  });
});

// express server post route hit by postman
managementAPI.listen(8080, () => {
  console.log(`Management API is running on PORT:8080`);
});

// http server
reverseProxy.listen(80, () => {
  console.log(`Reverse Proxy Is Running on PORT:80`);
});
