/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Context that can be attached to log entries
 */
export interface LogContext {
  correlationId?: string;
  operation?: string;
  repo?: string;
  taskId?: string;
  issueNumber?: number;
  projectId?: string;
  duration?: number;
  [key: string]: unknown;
}

/**
 * Structured log entry
 */
interface LogEntry {
  timestamp: string;
  level: string;
  correlationId: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Structured logger with correlation IDs for request tracing
 */
export class Logger {
  private correlationId: string;
  private level: LogLevel;
  private baseContext: LogContext;

  constructor(level: LogLevel = LogLevel.INFO, correlationId?: string, baseContext: LogContext = {}) {
    this.correlationId = correlationId ?? crypto.randomUUID();
    this.level = level;
    this.baseContext = baseContext;
  }

  /**
   * Get the correlation ID for this logger
   */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /**
   * Format a log entry as JSON
   */
  private format(level: string, message: string, context?: LogContext): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      message,
      ...this.baseContext,
      ...context,
    };
    return JSON.stringify(entry);
  }

  /**
   * Log a debug message
   */
  debug(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(this.format('DEBUG', message, context));
    }
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.INFO) {
      console.info(this.format('INFO', message, context));
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.format('WARN', message, context));
    }
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    if (this.level <= LogLevel.ERROR) {
      const errorContext: LogContext = {
        ...context,
      };

      if (error instanceof Error) {
        errorContext.errorMessage = error.message;
        errorContext.errorName = error.name;
        if (error.stack) {
          errorContext.errorStack = error.stack;
        }
      } else if (error !== undefined) {
        errorContext.errorValue = String(error);
      }

      console.error(this.format('ERROR', message, errorContext));
    }
  }

  /**
   * Create a child logger with additional context
   * The child inherits the correlation ID and base context
   */
  child(context: LogContext): Logger {
    return new Logger(this.level, this.correlationId, {
      ...this.baseContext,
      ...context,
    });
  }
}

/**
 * Create a new logger instance
 */
export function createLogger(level: LogLevel = LogLevel.INFO): Logger {
  return new Logger(level);
}
