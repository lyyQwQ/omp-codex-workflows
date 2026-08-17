import { spawn } from "node:child_process";

/**
 * 在后台执行尽力而为的通知命令。
 * 子进程通过 WORKFLOW_EVENT 接收序列化事件。
 */
export function spawnNotification(command, event) {
  try {
    spawn(command, [], {
      shell: true,
      env: { ...process.env, WORKFLOW_EVENT: JSON.stringify(event) },
      stdio: "ignore",
      // 终态通知必须在 runner 退出后继续执行。
      detached: true,
      windowsHide: true,
    }).unref();
  } catch {
    // 通知是尽力而为；启动失败不能中断工作流。
  }
}
