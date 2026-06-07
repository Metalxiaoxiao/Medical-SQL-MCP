/**
 * 增强的日志系统
 * 支持模块化日志记录，方便追踪代码执行路径
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'sql' | 'llm' | 'request' | 'response';

export interface LogOptions {
  module?: string;
  data?: any;
  truncate?: boolean;
  maxLength?: number;
}

export class Logger {
  private moduleName: string;
  private static logLevels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    sql: 1,
    llm: 1,
    request: 1,
    response: 1,
    warn: 2,
    error: 3
  };
  
  private static currentLogLevel: number = 1; // 默认info级别

  constructor(moduleName: string = 'unknown') {
    this.moduleName = moduleName;
    
    // 从环境变量读取日志级别
    const logLevel = process.env.LOG_LEVEL?.toLowerCase();
    if (logLevel && Logger.logLevels[logLevel as LogLevel] !== undefined) {
      Logger.currentLogLevel = Logger.logLevels[logLevel as LogLevel];
    }
  }

  /**
   * 创建模块特定的日志实例
   */
  static forModule(moduleName: string): Logger {
    return new Logger(moduleName);
  }

  /**
   * 格式化日志消息
   */
  private formatMessage(level: LogLevel, message: string, options?: LogOptions): string {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const module = options?.module || this.moduleName;
    return `[${level.toUpperCase()}][${timestamp}][${module}]${message}`;
  }

  /**
   * 格式化数据
   */
  private formatData(data: any, truncate: boolean = true, maxLength: number = 2000): string {
    if (!data) return '';
    
    try {
      const serialized = JSON.stringify(data, null, 2);
      if (truncate && serialized.length > maxLength) {
        return `(truncated): ${serialized.substring(0, maxLength)}...`;
      }
      return serialized;
    } catch (error) {
      return `[无法序列化数据: ${error}]`;
    }
  }

  /**
   * 检查是否应该记录该级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    return Logger.logLevels[level] >= Logger.currentLogLevel;
  }

  /**
   * 通用日志方法
   */
  private log(level: LogLevel, message: string, options?: LogOptions): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const formattedMessage = this.formatMessage(level, message, options);
    const data = options?.data;
    
    // 根据级别选择输出方式
    switch (level) {
      case 'error':
        console.error(formattedMessage);
        if (data) {
          console.error(this.formatData(data, options?.truncate, options?.maxLength));
        }
        break;
      case 'warn':
        console.warn(formattedMessage);
        if (data) {
          console.warn(this.formatData(data, options?.truncate, options?.maxLength));
        }
        break;
      default:
        console.info(formattedMessage);
        if (data) {
          console.info(this.formatData(data, options?.truncate, options?.maxLength));
        }
    }
  }

  // 公共日志方法
  debug(message: string, data?: any): void {
    this.log('debug', message, { data, module: this.moduleName });
  }

  info(message: string, data?: any): void {
    this.log('info', message, { data, module: this.moduleName });
  }

  warn(message: string, data?: any): void {
    this.log('warn', message, { data, module: this.moduleName });
  }

  error(message: string, error?: any): void {
    this.log('error', message, { 
      data: error, 
      module: this.moduleName,
      truncate: false // 错误信息不截断
    });
  }

  sql(query: string, result?: any): void {
    this.log('sql', `Executing: ${query}`, { 
      data: result ? { rowCount: Array.isArray(result) ? result.length : 'unknown' } : undefined,
      module: this.moduleName 
    });
  }

  llm(phase: string, data?: any): void {
    this.log('llm', phase, { 
      data, 
      module: this.moduleName,
      truncate: true,
      maxLength: 1000
    });
  }

  request(endpoint: string, data?: any): void {
    this.log('request', endpoint, { 
      data, 
      module: this.moduleName,
      truncate: true
    });
  }

  response(endpoint: string, data?: any): void {
    this.log('response', endpoint, { 
      data, 
      module: this.moduleName,
      truncate: true,
      maxLength: 2000
    });
  }

  /**
   * 创建子模块日志实例
   */
  createSubModule(subModuleName: string): Logger {
    return new Logger(`${this.moduleName}.${subModuleName}`);
  }
}

// 全局默认日志实例
export const defaultLogger = Logger.forModule('system');

// 常用模块的预定义日志实例
export const loggers = {
  system: defaultLogger,
  mcp: Logger.forModule('mcp'),
  db: Logger.forModule('db'),
  elasticsearch: Logger.forModule('elasticsearch'),
  llm: Logger.forModule('llm'),
  medical: Logger.forModule('medical'),
  classifier: Logger.forModule('classifier'),
  sync: Logger.forModule('sync'),
  rag: Logger.forModule('rag')
};

// 兼容旧代码的简化接口
export const log = {
  info: (message: string, data?: any) => defaultLogger.info(message, data),
  warn: (message: string, data?: any) => defaultLogger.warn(message, data),
  error: (message: string, error?: any) => defaultLogger.error(message, error),
  sql: (query: string, result?: any) => defaultLogger.sql(query, result),
  llm: (phase: string, data?: any) => defaultLogger.llm(phase, data),
  request: (endpoint: string, data?: any) => defaultLogger.request(endpoint, data),
  response: (endpoint: string, data?: any) => defaultLogger.response(endpoint, data)
};