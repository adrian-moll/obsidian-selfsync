import { runBackendContract } from "./support/backend-contract.js";
import { MemoryBackend } from "../src/backend/storage-backend.js";

runBackendContract("MemoryBackend", async () => ({
  backend: new MemoryBackend(),
  key: (n) => n,
  cleanup: async () => {},
}));
