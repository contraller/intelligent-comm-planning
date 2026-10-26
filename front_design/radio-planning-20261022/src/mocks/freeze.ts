// 固定教学常量沿用原顺序递归冻结，保留原对象身份及类型。
export function freezeMockData<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeMockData);
    Object.freeze(value);
  }
  return value;
}
