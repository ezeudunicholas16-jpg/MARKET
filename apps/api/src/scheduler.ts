import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

export interface ScheduledJobDefinition {
  name: string;
  queueName: string;
  jobName: string;
  cronUtc?: string;
  everyMs?: number;
  lagosLabel: string;
  description: string;
}

export const scheduledJobs: ScheduledJobDefinition[] = [
  {
    name: "global-market-brief",
    queueName: "market-desk-scheduler",
    jobName: "global_market_brief",
    cronUtc: "0 5 * * 1-5",
    lagosLabel: "06:00 Africa/Lagos",
    description: "Global cross-asset market brief"
  },
  {
    name: "london-fx-scan",
    queueName: "market-desk-scheduler",
    jobName: "london_fx_scan",
    cronUtc: "0 7 * * 1-5",
    lagosLabel: "08:00 Africa/Lagos",
    description: "London FX scan"
  },
  {
    name: "us-premarket-scan",
    queueName: "market-desk-scheduler",
    jobName: "us_premarket_scan",
    cronUtc: "0 12 * * 1-5",
    lagosLabel: "13:00 Africa/Lagos",
    description: "U.S. premarket scan"
  },
  {
    name: "us-open-mover-scan",
    queueName: "market-desk-scheduler",
    jobName: "us_open_mover_scan",
    cronUtc: "35 13 * * 1-5",
    lagosLabel: "14:35 Africa/Lagos",
    description: "U.S. market open mover scan"
  },
  {
    name: "mid-session-update",
    queueName: "market-desk-scheduler",
    jobName: "mid_session_update",
    cronUtc: "30 16 * * 1-5",
    lagosLabel: "17:30 Africa/Lagos",
    description: "Mid-session market update"
  },
  {
    name: "us-close-summary",
    queueName: "market-desk-scheduler",
    jobName: "us_close_summary",
    cronUtc: "10 20 * * 1-5",
    lagosLabel: "21:10 Africa/Lagos",
    description: "U.S. close summary"
  },
  {
    name: "breaking-catalyst-scan",
    queueName: "market-desk-scheduler",
    jobName: "breaking_catalyst_scan",
    everyMs: 15 * 60 * 1000,
    lagosLabel: "Every 15 minutes",
    description: "Breaking catalyst scan"
  }
];

export interface SchedulerHandle {
  queue: Queue;
  worker: Worker;
  close(): Promise<void>;
}

export async function startScheduler(redisUrl: string): Promise<SchedulerHandle> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("market-desk-scheduler", { connection });

  for (const job of scheduledJobs) {
    await queue.add(
      job.jobName,
      { name: job.name },
      {
        jobId: job.name,
        repeat: job.cronUtc ? { pattern: job.cronUtc } : { every: job.everyMs },
        removeOnComplete: 100,
        removeOnFail: 100
      }
    );
  }

  const worker = new Worker(
    "market-desk-scheduler",
    async (job) => {
      return {
        handled: true,
        jobName: job.name,
        at: new Date().toISOString()
      };
    },
    { connection }
  );

  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit();
    }
  };
}
