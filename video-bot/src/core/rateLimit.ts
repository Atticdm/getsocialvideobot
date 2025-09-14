import { logger } from './logger';

interface UserJob {
  userId: number;
  startTime: number;
}

class RateLimiter {
  private readonly maxConcurrentJobs = 3;
  private readonly activeJobs = new Map<number, UserJob[]>();
  private readonly queue = new Map<number, Array<(releaseFn: () => void) => void>>();

  async acquire(userId: number): Promise<() => void> {
    const userJobs = this.activeJobs.get(userId) || [];
    
    if (userJobs.length >= this.maxConcurrentJobs) {
      logger.debug('User rate limit reached, queuing job', { 
        userId, 
        activeJobs: userJobs.length,
        maxJobs: this.maxConcurrentJobs 
      });
      
      return new Promise<() => void>((resolve) => {
        const userQueue = this.queue.get(userId) || [];
        userQueue.push((releaseFn: () => void) => resolve(releaseFn));
        this.queue.set(userId, userQueue);
      });
    }

    return this.executeJob(userId);
  }

  private executeJob(userId: number): () => void {
    const userJobs = this.activeJobs.get(userId) || [];
    const jobId = Date.now();
    
    const job: UserJob = {
      userId,
      startTime: Date.now(),
    };

    userJobs.push(job);
    this.activeJobs.set(userId, userJobs);

    logger.debug('Job acquired', { 
      userId, 
      jobId, 
      activeJobs: userJobs.length 
    });

    return () => this.release(userId, job);
  }

  private release(userId: number, job: UserJob): void {
    const userJobs = this.activeJobs.get(userId) || [];
    const jobIndex = userJobs.indexOf(job);
    
    if (jobIndex !== -1) {
      userJobs.splice(jobIndex, 1);
      this.activeJobs.set(userId, userJobs);
      
      logger.debug('Job released', { 
        userId, 
        duration: Date.now() - job.startTime,
        activeJobs: userJobs.length 
      });
    }

    // Process queued jobs
    const userQueue = this.queue.get(userId) || [];
    if (userQueue.length > 0) {
      const nextJob = userQueue.shift()!;
      this.queue.set(userId, userQueue);
      
      // Execute next job asynchronously
      setImmediate(() => {
        const releaseFn = this.executeJob(userId);
        nextJob(releaseFn);
      });
    }
  }

  getStatus(userId: number): { active: number; queued: number } {
    const active = this.activeJobs.get(userId)?.length || 0;
    const queued = this.queue.get(userId)?.length || 0;
    
    return { active, queued };
  }
}

export const rateLimiter = new RateLimiter();
