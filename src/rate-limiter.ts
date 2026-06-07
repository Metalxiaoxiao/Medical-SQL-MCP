import { log } from './logger';

/**
 * 速率限制器
 * 用于控制API调用频率，避免超过RPM限制
 */
export class RateLimiter {
  private requests: number[] = []; // 存储请求时间戳
  private readonly maxRequests: number; // 最大请求数
  private readonly timeWindow: number; // 时间窗口（毫秒）
  private readonly minDelay: number; // 最小延迟（毫秒）

  /**
   * 创建速率限制器
   * @param maxRequests 最大请求数（例如：2000）
   * @param timeWindow 时间窗口（毫秒，例如：60000 = 1分钟）
   * @param minDelay 最小延迟（毫秒，例如：30 = 每分钟最多2000次）
   */
  constructor(maxRequests: number = 2000, timeWindow: number = 60000, minDelay: number = 30) {
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
    this.minDelay = minDelay;
  }

  /**
   * 等待直到可以发送下一个请求
   */
  async waitForNextRequest(): Promise<void> {
    const now = Date.now();
    
    // 清理过期的请求记录
    this.cleanup(now);
    
    // 如果请求数已达到限制，需要等待
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.timeWindow - (now - oldestRequest);
      
      if (waitTime > 0) {
        log.info(`Rate limit reached, waiting ${waitTime}ms...`);
        await this.delay(waitTime);
        
        // 等待后再次清理
        this.cleanup(Date.now());
      }
    }
    
    // 确保最小延迟
    if (this.requests.length > 0) {
      const lastRequest = this.requests[this.requests.length - 1];
      const timeSinceLastRequest = now - lastRequest;
      
      if (timeSinceLastRequest < this.minDelay) {
        const waitTime = this.minDelay - timeSinceLastRequest;
        log.info(`Enforcing minimum delay of ${waitTime}ms...`);
        await this.delay(waitTime);
      }
    }
    
    // 记录当前请求
    this.requests.push(Date.now());
    
    // 保持请求记录数量合理
    if (this.requests.length > this.maxRequests * 2) {
      this.requests = this.requests.slice(-this.maxRequests);
    }
  }

  /**
   * 清理过期的请求记录
   */
  private cleanup(now: number): void {
    const cutoff = now - this.timeWindow;
    this.requests = this.requests.filter(timestamp => timestamp > cutoff);
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    currentRequests: number;
    maxRequests: number;
    timeWindow: number;
    utilization: number;
  } {
    this.cleanup(Date.now());
    const utilization = (this.requests.length / this.maxRequests) * 100;
    
    return {
      currentRequests: this.requests.length,
      maxRequests: this.maxRequests,
      timeWindow: this.timeWindow,
      utilization
    };
  }

  /**
   * 重置速率限制器
   */
  reset(): void {
    this.requests = [];
  }
}

/**
 * 嵌入生成的速率限制器
 * 默认配置：每分钟最多2000次请求，最小延迟30ms
 */
export const embeddingRateLimiter = new RateLimiter(2000, 60000, 30);