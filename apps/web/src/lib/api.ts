import { ApiClient } from "@frontrun/core";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

let tokenGetter: () => Promise<string | null> = async () => null;

export function setTokenGetter(getter: () => Promise<string | null>) {
  tokenGetter = getter;
}

export function getToken() {
  return tokenGetter();
}

export const api = new ApiClient({
  baseUrl: API_URL,
  getToken: () => tokenGetter(),
});

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
