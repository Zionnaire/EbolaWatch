export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'app_error',
  ) {
    super(message);
    this.name = 'AppError';
  }
}
