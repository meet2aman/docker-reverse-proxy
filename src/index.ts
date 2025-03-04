import express from "express";
import http from "http";
import Docker from "dockerode";
import { Request, Response } from "express";
import { connectToRedis } from "./lib/redis";
import httpProxy from "http-proxy";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const proxy = httpProxy.createProxy({});

docker.getEvents(function (err, stream) {
  if (err) {
    console.log(`Error in getting events: ${err}`);
    return;
  }
  stream?.on("data", async (chunk) => {
    if (!chunk) return;
    const event = JSON.parse(chunk.toString());
    if (event.type === "container" && event.Action == "start") {
      const container = docker.getContainer(event.id);
      const containerInfo = await container.inspect();

      const containerName = containerInfo.Name.substring(1);
      const ipAddress = containerInfo.NetworkSettings.IPAddress;

      const exposedPort = Object.keys(containerInfo.Config.ExposedPorts);
      let defaultPort = null;

      if (exposedPort && exposedPort.length > 0) {
        const [port, type] = exposedPort[0].split("/");
        if (type === "tcp") {
          defaultPort = port;
        }
      }
      const redisClient = await connectToRedis();
      console.log(
        `Registering  ${containerName}.localhost ---> http://${ipAddress}:${defaultPort}`
      );

      await redisClient.hSet(containerName, {
        containerName,
        ipAddress,
        defaultPort: defaultPort || "",
      });
    }
  });
});

const reverseProxyApp = express();

reverseProxyApp.use(async (req, res) => {
  const hostName = req.hostname;
  const subDomain = hostName.split(".")[0];

  const client = await connectToRedis();
  const containerData = await client.hGetAll(subDomain);

  if (!containerData || Object.keys(containerData).length === 0) {
    res.status(404).end({ error: "Subdomain not found" });
  }

  const { ipAddress, defaultPort } = containerData;
  if (!ipAddress || !defaultPort) {
    res.status(500).end({ error: "Invalid container data" });
  }

  const target = `http://${ipAddress}:${defaultPort}`;

  console.log(`Forwording ${hostName} -> ${target}`);

  proxy.web(req, res, { target, changeOrigin: true });
});
const reverseProxy = http.createServer();

const managementAPI = express();
managementAPI.use(express.json());

managementAPI.post("/api/management", async (req: Request, res: Response) => {
  const { image, tag = "latest", name } = await req.body;
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
    name: name,
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

managementAPI.listen(8080, () => {
  console.log(`Management API is running on PORT:8080`);
});

reverseProxy.listen(80, () => {
  console.log(`Reverse Proxy Is Running on PORT:80`);
});
