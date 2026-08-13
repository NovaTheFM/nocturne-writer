/**
 * FastDOM v1.0.10
 * Eliminates layout thrashing by batching DOM read and write operations.
 * https://github.com/wilsonpage/fastdom
 */
class FastDom {
  constructor() {
    this.reads = [];
    this.writes = [];
    this.scheduled = false;
  }

  measure(fn, ctx) {
    const task = ctx ? fn.bind(ctx) : fn;
    this.reads.push(task);
    this.schedule();
    return task;
  }

  mutate(fn, ctx) {
    const task = ctx ? fn.bind(ctx) : fn;
    this.writes.push(task);
    this.schedule();
    return task;
  }

  clear(task) {
    return this._remove(this.reads, task) || this._remove(this.writes, task);
  }

  schedule() {
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  flush() {
    const reads = this.reads;
    const writes = this.writes;
    this.reads = [];
    this.writes = [];

    let error;

    try {
      this._runTasks(reads);
      this._runTasks(writes);
    } catch (e) {
      error = e;
    }

    this.scheduled = false;

    if (this.reads.length || this.writes.length) {
      this.schedule();
    }

    if (error) {
      throw error;
    }
  }

  _runTasks(tasks) {
    let task;
    while ((task = tasks.shift())) {
      task();
    }
  }

  _remove(array, item) {
    const index = array.indexOf(item);
    return index !== -1 ? !!array.splice(index, 1) : false;
  }
}

export const fastdom = new FastDom();
export default fastdom;
