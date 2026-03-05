#!/usr/bin/env node
/**
 * 邮件日历同步器 (本地邮件 → Nextcloud Calendar)
 * - 从本地邮件服务器 lili@lilibtc.com 获取最近邮件
 * - 识别重要事件（航班、会议、预约等）
 * - 自动添加到 Nextcloud Calendar
 * 
 * 用法: node mail-calendar-sync.mjs [--dry-run] [--days=7]
 * 
 * 环境变量:
 *   IMAP_HOST - IMAP服务器地址 (默认: 100.77.166.19)
 *   IMAP_USER - 邮箱用户名 (默认: lili@lilibtc.com)
 *   IMAP_PASS - 邮箱密码
 *   NEXTCLOUD_URL - Nextcloud地址 (默认: http://100.87.202.91:8081)
 *   NEXTCLOUD_USER - Nextcloud用户名 (默认: frank)
 *   NEXTCLOUD_PASS - Nextcloud密码/应用密码
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_PATH = join(__dirname, '../config/mail-sync-state.json');

// ========== 配置 ==========

const config = {
  imap: {
    host: process.env.IMAP_HOST || '100.77.166.19',
    port: 993,  // IMAPS 端口
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    user: process.env.IMAP_USER || 'lili',  // Stalwart 使用用户名，不是完整邮箱
    password: process.env.IMAP_PASS || ''
  },
  nextcloud: {
    url: process.env.NEXTCLOUD_URL || 'https://franks-mac-mini.taile3ecbd.ts.net',
    user: process.env.NEXTCLOUD_USER || 'frank',
    password: process.env.NEXTCLOUD_PASS || ''
  }
};

// 从环境变量或配置文件读取密码
function loadCredentials() {
  const credPath = join(__dirname, '../config/mail-credentials.json');
  if (existsSync(credPath)) {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    config.imap.password = creds.imap_password || config.imap.password;
    config.nextcloud.password = creds.nextcloud_password || config.nextcloud.password;
  }
  
  // 命令行参数
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--imap-pass=')) {
      config.imap.password = arg.split('=')[1];
    }
    if (arg.startsWith('--nc-pass=')) {
      config.nextcloud.password = arg.split('=')[1];
    }
  }
  
  if (!config.imap.password) {
    console.error('❌ 请设置 IMAP 密码 (环境变量 IMAP_PASS 或 --imap-pass)');
    process.exit(1);
  }
  if (!config.nextcloud.password) {
    console.error('❌ 请设置 Nextcloud 密码 (环境变量 NEXTCLOUD_PASS 或 --nc-pass)');
    process.exit(1);
  }
}

// ========== 工具函数 ==========

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { lastCheck: null, processedIds: [] };
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state) {
  state.lastCheck = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ========== 事件检测 ==========

const EVENT_PATTERNS = {
  flight: {
    patterns: [
      { regex: /航班[：:]\s*([A-Z0-9]+)/gi, field: 'flight_no' },
      { regex: /flight\s*[:#]?\s*([A-Z]{2}\s*\d+)/gi, field: 'flight_no' },
      { regex: /出发时间[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s*\d{1,2}:\d{2})/gi, field: 'departure' },
      { regex: /到达时间[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s*\d{1,2}:\d{2})/gi, field: 'arrival' },
      { regex: /departure[:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'date' },
    ],
    keywords: ['航班', '机票', '登机', 'flight', 'airline', 'boarding pass', 'eticket'],
    summary: '✈️ 航班',
    color: '#FF5722'
  },

  hotel: {
    patterns: [
      { regex: /酒店[：:]\s*(.+)/gi, field: 'hotel' },
      { regex: /入住[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'checkin' },
      { regex: /退房[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'checkout' },
      { regex: /check-?in[:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'checkin' },
      { regex: /check-?out[:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'checkout' },
    ],
    keywords: ['酒店', '预订', '入住', 'hotel', 'booking', 'reservation', 'check-in', '住宿'],
    summary: '🏨 酒店预订',
    color: '#4CAF50'
  },

  meeting: {
    patterns: [
      { regex: /会议[：:]\s*(.+?)(?:\n|$)/gi, field: 'title' },
      { regex: /时间[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s*\d{1,2}:\d{2})/gi, field: 'datetime' },
      { regex: /地点[：:]\s*(.+?)(?:\n|$)/gi, field: 'location' },
      { regex: /meeting[:\s]+(.+?)(?:\n|$)/gi, field: 'title' },
      { regex: /(zoom\.us\/j\/\d+)/gi, field: 'zoom' },
      { regex: /(teams\.microsoft\.com\/[^\s]+)/gi, field: 'teams' },
    ],
    keywords: ['会议', '邀请', 'meeting', 'invitation', 'zoom', 'teams', 'schedule', 'calendar invite'],
    summary: '📅 会议',
    color: '#2196F3'
  },

  appointment: {
    patterns: [
      { regex: /预约时间[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s*\d{1,2}:\d{2})/gi, field: 'datetime' },
      { regex: /预约地点[：:]\s*(.+?)(?:\n|$)/gi, field: 'location' },
      { regex: /appointment[:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'date' },
    ],
    keywords: ['预约', '挂号', '体检', 'appointment', 'booking', 'reservation'],
    summary: '📋 预约',
    color: '#9C27B0'
  },

  payment: {
    patterns: [
      { regex: /到期日[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'due_date' },
      { regex: /金额[：:]\s*([¥$￥]?\s*\d+[,，]?\d*\.?\d*)/gi, field: 'amount' },
      { regex: /due[:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'due_date' },
    ],
    keywords: ['账单', '缴费', '还款', 'bill', 'payment', 'due', 'invoice', '账单提醒', '扣款'],
    summary: '💳 账单',
    color: '#F44336'
  },

  delivery: {
    patterns: [
      { regex: /快递单号[：:]\s*([A-Z0-9]+)/gi, field: 'tracking' },
      { regex: /预计送达[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'delivery_date' },
      { regex: /tracking[:\s#]+([A-Z0-9]+)/gi, field: 'tracking' },
      { regex: /(SF|顺丰|中通|圆通|韵达|申通|极兔)[：:]*\s*([A-Z0-9]+)/gi, field: 'tracking' },
    ],
    keywords: ['快递', '包裹', '送达', 'delivery', 'package', 'shipping', '物流', '派送'],
    summary: '📦 快递',
    color: '#FF9800'
  },

  travel: {
    patterns: [
      { regex: /行程[：:]\s*(.+?)(?:\n|$)/gi, field: 'itinerary' },
      { regex: /出发日期[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'start_date' },
      { regex: /返回日期[：:]\s*(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/gi, field: 'end_date' },
    ],
    keywords: ['行程', '旅游', '机票确认', 'itinerary', 'travel', 'trip'],
    summary: '🧳 旅行',
    color: '#00BCD4'
  }
};

function detectEvents(mail) {
  const fullText = `${mail.subject || ''}\n${mail.text || ''}\n${mail.html || ''}`.toLowerCase();
  const detectedEvents = [];

  for (const [type, eventConfig] of Object.entries(EVENT_PATTERNS)) {
    const hasKeyword = eventConfig.keywords.some(kw => fullText.includes(kw.toLowerCase()));
    
    if (hasKeyword) {
      const eventData = {
        type,
        summary: `${eventConfig.summary}: ${mail.subject || '(无主题)'}`,
        color: eventConfig.color,
        source: mail.from?.text || '',
        messageId: mail.messageId,
        date: mail.date,
        extracted: {}
      };

      // 提取具体信息
      for (const { regex, field } of eventConfig.patterns) {
        const matches = [...fullText.matchAll(regex)];
        if (matches.length > 0 && matches[0][1]) {
          eventData.extracted[field] = matches[0][1].trim();
        }
      }

      // 尝试提取日期
      const datePatterns = [
        /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/g,
        /(\d{1,2}月\d{1,2}日)/g,
        /(\d{1,2}\/\d{1,2}\/\d{4})/g,
      ];
      
      for (const dp of datePatterns) {
        const match = fullText.match(dp);
        if (match) {
          eventData.extracted.date = match[0];
          break;
        }
      }

      // 尝试提取时间
      const timeMatch = fullText.match(/(\d{1,2}:\d{2})/);
      if (timeMatch) {
        eventData.extracted.time = timeMatch[1];
      }

      detectedEvents.push(eventData);
    }
  }

  return detectedEvents;
}

// ========== IMAP 操作 ==========

function fetchEmails(days = 7) {
  return new Promise((resolve, reject) => {
    const emails = [];
    const imap = new Imap(config.imap);
    
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }
        
        // 计算搜索日期
        const searchDate = new Date();
        searchDate.setDate(searchDate.getDate() - days);
        const dateStr = searchDate.toISOString().split('T')[0];
        
        console.log(`📬 搜索 ${dateStr} 以来的邮件...`);
        
        imap.search(['UNSEEN', ['SINCE', searchDate]], (err, results) => {
          if (err) {
            imap.end();
            return reject(err);
          }
          
          if (!results || results.length === 0) {
            console.log('   没有新邮件');
            imap.end();
            return resolve([]);
          }
          
          console.log(`   找到 ${results.length} 封未读邮件`);
          
          const fetch = imap.fetch(results, { bodies: '' });
          
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (!err) {
                  emails.push(parsed);
                }
              });
            });
          });
          
          fetch.once('error', reject);
          fetch.once('end', () => imap.end());
        });
      });
    });
    
    imap.once('error', reject);
    imap.connect();
  });
}

// ========== Nextcloud Calendar 操作 ==========

async function getNextcloudCalendars() {
  const { url, user, password } = config.nextcloud;
  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  
  const response = await fetch(`${url}/remote.php/dav/calendars/${user}/`, {
    method: 'PROPFIND',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/xml',
      'Depth': '1'
    },
    body: `<?xml version="1.0" encoding="utf-8"?>
      <d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:calendaring">
        <d:prop>
          <d:displayname />
          <d:resourcetype />
          <cal:calendar-color />
        </d:prop>
      </d:propfind>`
  });
  
  const text = await response.text();
  
  // 解析日历列表
  const calendars = [];
  const hrefMatches = text.matchAll(/<d:href>([^<]+)<\/d:href>/g);
  const nameMatches = text.matchAll(/<d:displayname>([^<]*)<\/d:displayname>/g);
  
  const hrefs = [...hrefMatches].map(m => m[1]);
  const names = [...nameMatches].map(m => m[1]);
  
  for (let i = 0; i < hrefs.length; i++) {
    if (hrefs[i].includes('calendar') && names[i]) {
      calendars.push({
        href: hrefs[i],
        name: names[i]
      });
    }
  }
  
  return calendars;
}

async function createNextcloudEvent(event, calendarHref) {
  const { url, user, password } = config.nextcloud;
  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  
  // 生成事件 UID
  const uid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@lilibtc.com`;
  
  // 解析日期时间
  let startDateTime = event.date || new Date();
  let endDateTime = new Date(new Date(startDateTime).getTime() + 3600000); // 默认1小时后
  
  if (event.extracted.datetime) {
    startDateTime = new Date(event.extracted.datetime);
    endDateTime = new Date(startDateTime.getTime() + 3600000);
  } else if (event.extracted.date) {
    const dateStr = event.extracted.date.replace(/[\/]/g, '-');
    startDateTime = new Date(dateStr);
    endDateTime = new Date(startDateTime.getTime() + 86400000); // 全天事件
  }
  
  if (event.extracted.time) {
    const [hours, minutes] = event.extracted.time.split(':').map(Number);
    startDateTime.setHours(hours, minutes, 0);
    endDateTime = new Date(startDateTime.getTime() + 3600000);
  }
  
  // 格式化日期
  const formatDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  
  // 构建 iCalendar 内容
  const icalContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Mail Calendar Sync//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${formatDate(new Date())}
DTSTART:${formatDate(startDateTime)}
DTEND:${formatDate(endDateTime)}
SUMMARY:${event.summary}
DESCRIPTION:来源: ${event.source}\\n邮件ID: ${event.messageId}\\n\\n${JSON.stringify(event.extracted, null, 2)}
CATEGORIES:${event.type}
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');

  const eventUrl = `${url}${calendarHref.replace(/\/$/, '')}/${uid}.ics`;
  
  const response = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*'
    },
    body: icalContent
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  
  return { uid, url: eventUrl };
}

// ========== 主逻辑 ==========

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const daysArg = process.argv.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1]) : 7;
  
  loadCredentials();
  
  console.log('📧 邮件日历同步器 (本地邮件 → Nextcloud)');
  console.log(`   邮箱: ${config.imap.user}`);
  console.log(`   Nextcloud: ${config.nextcloud.url}`);
  console.log(`   检查天数: ${days} 天`);
  console.log(`   模式: ${dryRun ? '预览 (dry-run)' : '正式运行'}`);
  console.log('');
  
  const state = loadState();
  const processedIds = new Set(state.processedIds.slice(-1000));
  
  try {
    // 获取邮件
    const emails = await fetchEmails(days);
    
    if (emails.length === 0) {
      console.log('✅ 没有需要处理的邮件');
      return;
    }
    
    // 获取 Nextcloud 日历
    let defaultCalendar = null;
    if (!dryRun) {
      console.log('📅 获取 Nextcloud 日历...');
      const calendars = await getNextcloudCalendars();
      console.log(`   找到 ${calendars.length} 个日历`);
      
      defaultCalendar = calendars.find(c => c.name === 'personal' || c.href.includes('personal'))
                      || calendars.find(c => c.name === '默认' || c.name.toLowerCase().includes('default'))
                      || calendars[0];
      
      if (!defaultCalendar) {
        throw new Error('没有找到可用的日历');
      }
      console.log(`   使用日历: ${defaultCalendar.name}`);
    }
    
    let newEventsCount = 0;
    
    for (const mail of emails) {
      // 跳过已处理的邮件
      if (processedIds.has(mail.messageId)) {
        continue;
      }
      
      // 检测事件
      const events = detectEvents(mail);
      
      if (events.length > 0) {
        console.log(`\n📩 ${mail.subject || '(无主题)'}`);
        console.log(`   发件人: ${mail.from?.text || '未知'}`);
        console.log(`   日期: ${mail.date?.toLocaleString('zh-CN') || '未知'}`);
        
        for (const event of events) {
          console.log(`   检测到: ${event.summary}`);
          
          if (event.extracted.date) {
            console.log(`   日期: ${event.extracted.date}`);
          }
          if (event.extracted.time) {
            console.log(`   时间: ${event.extracted.time}`);
          }
          
          if (!dryRun) {
            try {
              const result = await createNextcloudEvent(event, defaultCalendar.href);
              console.log(`   ✅ 已添加到日历`);
              newEventsCount++;
            } catch (error) {
              console.log(`   ❌ 添加失败: ${error.message}`);
            }
          } else {
            console.log(`   [dry-run] 将添加到日历`);
            newEventsCount++;
          }
        }
        
        // 记录已处理
        processedIds.add(mail.messageId);
      }
    }
    
    // 更新状态
    state.processedIds = Array.from(processedIds);
    saveState(state);
    
    console.log('\n' + '─'.repeat(50));
    console.log(`✅ 完成! 新增事件: ${newEventsCount}`);
    console.log(`   下次检查: ${state.lastCheck}`);
    
  } catch (error) {
    console.error('❌ 错误:', error.message);
    process.exit(1);
  }
}

main();
