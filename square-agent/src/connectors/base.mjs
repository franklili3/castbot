// base.mjs — Connector 统一接口定义
//
// 所有平台 Connector 实现这个接口
// 新增平台只需实现这些方法

export class BaseConnector {
  constructor(config = {}) {
    this.name = 'base';
    this.platform = 'base';
    this.capabilities = {
      text: true,
      image: false,
      video: false,
      poll: false,
      longArticle: false,
      delete: false,
      stats: false,
    };
    this.config = config;
  }

  /**
   * 发布内容
   * @param {string} content - 文本内容
   * @param {object} options - { images, title, poll, scheduledAt }
   * @returns {object} { success, postId, postUrl, error }
   */
  async publish(content, options = {}) {
    throw new Error(`${this.name}: publish() not implemented`);
  }

  /**
   * 删除帖子
   * @param {string} postId
   * @returns {object} { success, error }
   */
  async delete(postId) {
    return { success: false, error: `${this.name}: delete not supported` };
  }

  /**
   * 获取帖子互动数据
   * @param {string} postId
   * @returns {object} { views, likes, comments, shares }
   */
  async getStats(postId) {
    return { views: 0, likes: 0, comments: 0, shares: 0 };
  }

  /**
   * 检查账号健康度
   * @returns {object} { healthy, issues, warnings }
   */
  async checkHealth() {
    return { healthy: true, issues: [], warnings: [] };
  }

  /**
   * 获取今日已发布数量
   * @returns {number}
   */
  async getDailyCount() {
    return 0;
  }
}
