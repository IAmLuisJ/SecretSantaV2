import { createContext } from "react-router";
import type { Env } from "./env";

export const workerContext = createContext<{ env: Env; executionContext: ExecutionContext }>();
