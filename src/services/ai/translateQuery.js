import axios from 'axios';

// Local translation dictionary to bypass network requests for common search keywords
export const LOCAL_TRANSLATION_DICT = {
  '猫': 'cat', '猫咪': 'cat', '小猫': 'cat',
  '狗': 'dog', '狗狗': 'dog', '小狗': 'dog',
  '海滩': 'beach', '沙滩': 'beach', '海边': 'beach',
  '食物': 'food', '美食': 'food', '吃': 'food', '菜': 'food',
  '风景': 'scenery', '风景照': 'scenery', '山水': 'scenery',
  '花': 'flower', '花卉': 'flower', '鲜花': 'flower',
  '截图': 'screenshot', '屏幕截图': 'screenshot',
  '汽车': 'car', '车': 'car', '小汽车': 'car',
  '宝宝': 'baby', '婴儿': 'baby', '小孩': 'baby', '孩子': 'baby',
  '森林': 'forest', '树木': 'forest', '树': 'forest',
  '雪山': 'snow mountain', '雪': 'snow', '下雪': 'snow',
  '夜景': 'night view', '晚上': 'night', '夜里': 'night',
  '建筑': 'building', '房子': 'building', '大楼': 'building',
  '咖啡': 'coffee', '下午茶': 'coffee',
  '自行车': 'bicycle', '单车': 'bicycle', '脚踏车': 'bicycle',
  '运动': 'sports', '健身': 'sports', '跑步': 'sports',
  '旅行': 'travel', '旅游': 'travel', '游玩': 'travel',
  '海洋': 'ocean', '大海': 'ocean', '海': 'ocean',
  '红叶': 'autumn leaves', '枫叶': 'autumn leaves', '秋天': 'autumn',
  '音乐': 'music', '乐器': 'music',
  '人': 'person', '人们': 'people', '大家': 'people',
  '女人': 'woman', '女生': 'woman', '男人': 'man', '男生': 'man',
  '天空': 'sky', '云': 'cloud', '蓝天': 'sky',
  '水': 'water', '河流': 'river', '江河': 'river', '湖泊': 'river',
  '草地': 'grassland', '草': 'grass', '绿草': 'grass',
  '电脑': 'computer', '手机': 'phone', '数码': 'digital',
  '书': 'book', '阅读': 'book', '书籍': 'book'
};

const CJK_PATTERN = /[一-龥]/;

export function containsChinese(text) {
  return CJK_PATTERN.test(text);
}

// Translates a Chinese search query to English so it can be matched against
// CLIP embeddings (trained on English captions). Tries the local dictionary
// first to avoid a network round-trip for common search terms, then falls
// back to Google's translate endpoint. Non-Chinese input, and any failure to
// translate, both return the original text unchanged.
export async function translateToEnglish(text) {
  if (!containsChinese(text)) return text;

  const cleanQuery = text.trim().toLowerCase();
  const localMatch = LOCAL_TRANSLATION_DICT[cleanQuery];
  if (localMatch) {
    console.log(`[translateQuery] Local dictionary translation: "${text}" -> "${localMatch}"`);
    return localMatch;
  }

  try {
    const res = await axios.get(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`,
      { timeout: 5000, skipAutoProbe: true }
    );
    const translated = res.data?.[0]?.[0]?.[0];
    if (translated) {
      console.log(`[translateQuery] Online translated: "${text}" -> "${translated}"`);
      return translated;
    }
  } catch (e) {
    console.warn('[translateQuery] Online translation failed, using original:', e.message);
  }
  return text;
}
