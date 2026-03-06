const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const iconv = require('iconv-lite'); // 添加编码转换库

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// 股票数据缓存
const stockCache = new Map();

// 获取股票实时数据 - 支持 A 股和港股
async function fetchStockData(code) {
  const cacheKey = code.toUpperCase();
  const cached = stockCache.get(cacheKey);
  
  // 5 分钟内使用缓存
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return cached.data;
  }

  try {
    // 判断市场类型
    let market, symbol;
    const codeNum = parseInt(code);
    
    // 港股：5位数字，通常是 00001-09999 或 5位
    if (code.length === 5 || (code.length === 4 && codeNum >= 1 && codeNum <= 9999)) {
      market = 'hk';
      symbol = `hk${code}`;
    } else {
      // A股
      if (code.startsWith('6')) market = 'sh';
      else if (code.startsWith('4') || code.startsWith('8')) market = 'bj';
      else market = 'sz';
      symbol = `${market}${code}`;
    }
    
    // 使用新浪财经 API
    const response = await axios.get(
      `http://hq.sinajs.cn/list=${symbol}`,
      {
        timeout: 10000,
        responseType: 'arraybuffer', // 获取二进制数据
        headers: {
          'Referer': 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    );
    
    // 转换编码（新浪财经返回 GBK）
    const data = iconv.decode(response.data, 'gbk');
    if (data && data.includes('=')) {
      const parts = data.split('=')[1].replace(/"/g, '').split(',');
      
      // 港股数据格式不同
      if (market === 'hk') {
        if (parts.length >= 6) {
          const stockData = {
            code: code,
            name: parts[1],
            open: parseFloat(parts[2]),
            high: parseFloat(parts[4]),
            low: parseFloat(parts[5]),
            price: parseFloat(parts[6]),
            preClose: parseFloat(parts[3]),
            change: parseFloat(parts[6]) - parseFloat(parts[3]),
            changePercent: ((parseFloat(parts[6]) - parseFloat(parts[3])) / parseFloat(parts[3]) * 100),
            volume: parseFloat(parts[12]) || 0,
            amount: parseFloat(parts[11]) || 0,
            market: '港股',
            update: new Date().toISOString()
          };
          
          // 获取港股额外数据
          const extraData = await fetchHKExtraData(code);
          Object.assign(stockData, extraData);
          
          stockCache.set(cacheKey, { data: stockData, timestamp: Date.now() });
          return stockData;
        }
      } else {
        // A股数据格式
        if (parts.length >= 32) {
          const stockData = {
            code: code,
            name: parts[0],
            open: parseFloat(parts[1]),
            preClose: parseFloat(parts[2]),
            price: parseFloat(parts[3]),
            high: parseFloat(parts[4]),
            low: parseFloat(parts[5]),
            volume: parseFloat(parts[8]),
            amount: parseFloat(parts[9]),
            change: parseFloat(parts[3]) - parseFloat(parts[2]),
            changePercent: ((parseFloat(parts[3]) - parseFloat(parts[2])) / parseFloat(parts[2]) * 100),
            market: market === 'sh' ? '沪市' : (market === 'sz' ? '深市' : '北交所'),
            update: new Date().toISOString()
          };
          
          // 获取A股额外数据
          const extraData = await fetchExtraData(code, market);
          Object.assign(stockData, extraData);
          
          stockCache.set(cacheKey, { data: stockData, timestamp: Date.now() });
          return stockData;
        }
      }
    }
  } catch (error) {
    console.error(`获取股票数据失败 ${code}:`, error.message);
  }

  return null;
}

// 获取港股额外数据
async function fetchHKExtraData(code) {
  try {
    // 港股数据获取（使用腾讯财经 API 作为补充）
    const response = await axios.get(
      `http://qt.gtimg.cn/q=hk${code}`,
      { 
        timeout: 5000,
        responseType: 'arraybuffer'
      }
    );
    
    const data = iconv.decode(response.data, 'gbk');
    if (data && data.includes('=')) {
      const parts = data.split('=')[1].replace(/"/g, '').split('~');
      if (parts.length >= 45) {
        return {
          pe: parseFloat(parts[52]) || 0,  // 市盈率
          pb: parseFloat(parts[53]) || 0,  // 市净率
          totalMarketCap: parseFloat(parts[44]) || 0,  // 总市值
          eps: parseFloat(parts[55]) || 0,  // 每股收益
          dividendYield: parseFloat(parts[62]) || 0,  // 股息率
          fiftyTwoWeekHigh: parseFloat(parts[33]) || 0,  // 52周最高
          fiftyTwoWeekLow: parseFloat(parts[34]) || 0,  // 52周最低
          volumeRatio: parseFloat(parts[57]) || 0  // 换手率
        };
      }
    }
  } catch (e) {
    console.error('港股额外数据获取失败:', e.message);
  }
  
  return {
    pe: 0, pb: 0, totalMarketCap: 0, eps: 0, dividendYield: 0,
    fiftyTwoWeekHigh: 0, fiftyTwoWeekLow: 0, volumeRatio: 0
  };
}

// 获取A股额外财务数据
async function fetchExtraData(code, market) {
  try {
    const response = await axios.get(
      `https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_Service/StockCN.getStockData?symbol=${market}${code}`,
      { timeout: 5000 }
    );
    
    // 解析 JSONP 响应
    const jsonStr = response.data.replace(/^\/\*.*\*\//, '').replace(/=/, '').trim();
    const data = JSON.parse(jsonStr);
    
    return {
      pe: parseFloat(data.pe) || 0,
      pb: parseFloat(data.pb) || 0,
      totalMarketCap: parseFloat(data.marketcap) || 0,
      eps: parseFloat(data.eps) || 0,
      bvps: parseFloat(data.bvps) || 0,
      dividendYield: parseFloat(data.dividend) || 0
    };
  } catch (e) {
    // 如果获取失败，返回默认值
    return {
      pe: 0, pb: 0, totalMarketCap: 0, eps: 0, bvps: 0, dividendYield: 0
    };
  }
}

// 获取股票分析
async function fetchStockAnalysis(code) {
  try {
    const stockData = await fetchStockData(code);
    if (!stockData) {
      return null;
    }

    const analysis = generateAnalysis(stockData);
    
    return {
      ...stockData,
      analysis
    };
  } catch (error) {
    console.error('分析失败:', error.message);
    return null;
  }
}

function generateAnalysis(data) {
  const { pe, pb, changePercent, price, market } = data;
  const isHK = market === '港股';
  
  // 估值判断（港股和A股标准不同）
  let valuation = '合理';
  if (isHK) {
    // 港股估值通常较低
    if (pe > 30) valuation = '偏高';
    if (pe > 50) valuation = '高估';
    if (pe > 0 && pe < 10) valuation = '偏低';
    if (pe > 0 && pe < 5) valuation = '低估';
  } else {
    // A股标准
    if (pe > 50) valuation = '偏高';
    if (pe > 80) valuation = '高估';
    if (pe > 0 && pe < 20) valuation = '偏低';
    if (pe > 0 && pe < 10) valuation = '低估';
  }

  // 趋势判断
  let trend = '震荡';
  if (changePercent > 3) trend = '强势上涨';
  if (changePercent > 5) trend = '大幅上涨';
  if (changePercent < -3) trend = '弱势下跌';
  if (changePercent < -5) trend = '大幅下跌';

  // 操作建议
  let suggestion = '持有观望';
  if (isHK) {
    if (pe > 0 && pe < 10 && changePercent > 0) suggestion = '可考虑买入';
    if (pe > 40 && changePercent > 5) suggestion = '注意风险，可考虑减仓';
  } else {
    if (pe > 0 && pe < 20 && changePercent > 0) suggestion = '可考虑买入';
    if (pe > 60 && changePercent > 5) suggestion = '注意风险，可考虑减仓';
  }
  if (changePercent < -5 && pe > 0 && pe < 30) suggestion = '可逢低布局';

  return {
    valuation,
    trend,
    suggestion,
    score: calculateScore(data),
    risks: generateRisks(data),
    highlights: generateHighlights(data),
    market: isHK ? '港股' : 'A股'
  };
}

function calculateScore(data) {
  let score = 50;
  
  // 估值分
  if (data.pe > 0 && data.pe < 20) score += 20;
  else if (data.pe > 0 && data.pe < 40) score += 10;
  else if (data.pe > 60) score -= 15;
  else if (data.pe > 80) score -= 25;
  
  // 趋势分
  if (data.changePercent > 3) score += 15;
  else if (data.changePercent > 1) score += 5;
  else if (data.changePercent < -3) score -= 15;
  else if (data.changePercent < -1) score -= 5;
  
  // 市净率分
  if (data.pb > 0 && data.pb < 2) score += 10;
  else if (data.pb > 0 && data.pb < 4) score += 5;
  else if (data.pb > 10) score -= 10;
  
  return Math.max(0, Math.min(100, score));
}

function generateRisks(data) {
  const risks = [];
  if (data.pe > 50) risks.push('估值偏高，存在回调风险');
  if (data.pe > 80) risks.push('估值过高，需谨慎');
  if (data.pb > 10) risks.push('市净率较高');
  if (data.changePercent > 5) risks.push('短期涨幅较大，注意获利回吐');
  if (data.changePercent < -5) risks.push('短期跌幅较大，注意继续下行风险');
  if (risks.length === 0) risks.push('暂无重大风险');
  return risks;
}

function generateHighlights(data) {
  const highlights = [];
  if (data.pe > 0 && data.pe < 20) highlights.push('估值处于较低水平');
  if (data.changePercent > 3) highlights.push('今日表现强势');
  if (data.pb > 0 && data.pb < 3) highlights.push('市净率较低，安全边际高');
  if (data.dividendYield > 2) highlights.push(`股息率${data.dividendYield.toFixed(2)}%，分红可观`);
  if (highlights.length === 0) highlights.push('暂无特别亮点');
  return highlights;
}

// API 路由
app.get('/api/stock/:code', async (req, res) => {
  const { code } = req.params;
  const data = await fetchStockData(code);
  
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(404).json({ success: false, message: '未找到股票数据' });
  }
});

app.get('/api/analyze/:code', async (req, res) => {
  const { code } = req.params;
  const data = await fetchStockAnalysis(code);
  
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(404).json({ success: false, message: '分析失败' });
  }
});

// 前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 股票分析服务器运行在 http://localhost:${PORT}`);
});
