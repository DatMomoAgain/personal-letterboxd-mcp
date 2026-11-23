// Inspection mode, for MCP directories such as Glama: the same tools over stdio, with no Letterboxd
// data and a throwaway taste memory, so a directory can start the server and list its tools.
// Not a way to use it; the real server is the Worker (src/index.ts).
//
//   node --experimental-strip-types --no-warnings src/stdio.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { inMemoryStore } from "./memory.ts";
import { buildServer } from "./server.ts";

await buildServer(null, inMemoryStore()).connect(new StdioServerTransport());
