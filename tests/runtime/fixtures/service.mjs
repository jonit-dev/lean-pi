// The service fixture `runtime_smoke` starts (PRD-022 AC-1).
//
// It prints its own pid so the spec can prove no child survives the verifier,
// then the readiness marker the contract's `ready.log` declares. `--fail`
// switches to the boot-failure shape: stderr and a non-zero exit, because a
// verifier that turned that into a pass would be manufacturing evidence.
import { createServer } from "node:http";

if (process.argv.includes("--fail")) {
	console.error(`BOOT_FAILURE pid ${process.pid}`);
	console.error("BOOT_STDERR the fixture service cannot bind its port");
	process.exit(1);
}

const port = Number(process.argv[2] ?? 0);
const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("service ok\n");
});

server.listen(port, "127.0.0.1", () => {
	const address = server.address();
	const bound = typeof address === "object" && address !== null ? address.port : port;
	console.log(`SERVICE_PID ${process.pid}`);
	console.log(`SERVICE_READY http://127.0.0.1:${bound}`);
});
