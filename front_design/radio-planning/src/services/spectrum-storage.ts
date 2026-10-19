import { SPECTRUM_STORAGE_KEY } from '../config/demo';
import { initialSpectrum } from '../mocks/spectrum-presets';
import type { ResourceStorage } from '../types/resource-edit';
import type { SpectrumWorkspace } from '../types/spectrum';
import { assertSpectrum } from './spectrum-validation';
import { ApiError } from './types';
// 频谱单独持久化；异常不能伪装成空配置。
export function readSpectrum(storage:ResourceStorage):SpectrumWorkspace {
  let raw:string|null;
  try{raw=storage.getItem(SPECTRUM_STORAGE_KEY);}catch{throw new ApiError('频谱存储读取失败','SPECTRUM_READ_FAILED');}
  if(raw===null)return initialSpectrum();
  try{const value=JSON.parse(raw);assertSpectrum(value);return value;}catch{throw new ApiError('频谱记录损坏，原记录已保留，可明确重置','SPECTRUM_CORRUPT');}
}
export function writeSpectrum(storage:ResourceStorage,w:SpectrumWorkspace){
  assertSpectrum(w);
  try{storage.setItem(SPECTRUM_STORAGE_KEY,JSON.stringify(w));}catch{throw new ApiError('频谱保存失败，原记录和输入已保留','SPECTRUM_WRITE_FAILED');}
}
