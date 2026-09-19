interface PendingEstimation {
  slug: string
  run: () => Promise<void>
}

/** Bounds whole pipelines, including reads and writeback; the same recipe never runs twice at once. */
export class EstimationQueue {
  private readonly activeSlugs = new Set<string>()
  private readonly pending: PendingEstimation[] = []

  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Estimation concurrency must be a positive integer")
    }
  }

  run<T>(slug: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        slug,
        run: async () => {
          try {
            resolve(await task())
          } catch (err) {
            reject(err)
          } finally {
            this.activeSlugs.delete(slug)
            this.drain()
          }
        },
      })
      this.drain()
    })
  }

  private drain(): void {
    while (this.activeSlugs.size < this.concurrency) {
      const next = this.pending.findIndex((job) => !this.activeSlugs.has(job.slug))
      if (next === -1) return
      const [job] = this.pending.splice(next, 1)
      this.activeSlugs.add(job.slug)
      void job.run()
    }
  }
}
