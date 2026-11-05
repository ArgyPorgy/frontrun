export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "That") => new AppError(404, "not_found", `${what} wasn't found.`);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const forbidden = (message = "You can't do that.") => new AppError(403, "forbidden", message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
