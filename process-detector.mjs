/**
 * 跨平台进程检测工具
 * 用于检测 agent.mjs 进程是否在运行
 */
class ProcessDetector {
  /**
   * 检查指定 PID 的进程是否在运行
   * @param {number} pid - 进程 ID
   * @returns {Promise<boolean>} - 进程是否运行中
   */
  static async isRunning(pid) {
    const platform = process.platform;

    try {
      switch (platform) {
        case 'linux':
          return await this._checkOnLinux(pid);
        case 'darwin':
          return await this._checkOnDarwin(pid);
        case 'win32':
          return await this._checkOnWindows(pid);
        default:
          console.warn(`Unsupported platform: ${platform}`);
          return false;
      }
    } catch (error) {
      console.error(`Process check error: ${error.message}`);
      return false;
    }
  }

  /**
   * Linux 平台：读取 /proc 文件系统
   */
  static async _checkOnLinux(pid) {
    try {
      const { readFileSync } = await import('fs');
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.includes('agent.mjs');
    } catch {
      return false; // 进程不存在
    }
  }

  /**
   * macOS 平台：使用 ps 命令
   */
  static async _checkOnDarwin(pid) {
    try {
      const { execSync } = await import('child_process');
      const result = execSync(`ps -p ${pid} -o command=`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return result.includes('agent.mjs');
    } catch {
      return false; // 进程不存在
    }
  }

  /**
   * Windows 平台：使用 tasklist 和 wmic
   */
  static async _checkOnWindows(pid) {
    try {
      const { execSync } = await import('child_process');

      // 方法1: 使用 tasklist 检查进程是否存在
      const tasklist = execSync(
        `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );

      if (!tasklist.includes('node.exe')) {
        return false;
      }

      // 方法2: 使用 wmic 检查命令行参数
      const wmic = execSync(
        `wmic process where "ProcessId=${pid}" get CommandLine /Format:list`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );

      return wmic.includes('agent.mjs');
    } catch {
      return false; // 进程不存在或命令失败
    }
  }

  /**
   * 检查 lockfile 中的 PID 是否真的是另一个 lilibtc-bot 实例
   * 返回: 'alive-agent' | 'alive-other' | 'dead' | 'unknown'
   */
  static async checkLockOwner(pid) {
    if (!pid || Number.isNaN(pid)) return 'unknown';

    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      return 'dead';
    }

    if (!alive) return 'dead';

    // 使用跨平台检测验证是否是 agent.mjs 进程
    const isAgentProcess = await this.isRunning(pid);
    if (isAgentProcess) {
      return 'alive-agent';
    }

    return 'alive-other';
  }
}

export default ProcessDetector;
