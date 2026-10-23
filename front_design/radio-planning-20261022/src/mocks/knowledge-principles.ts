import type { KnowledgePrincipleFlow } from '../types/knowledge';

// 新基线直接保存步骤，读取端不再根据旧实体内容回填。
export const knowledgePrincipleFlow: KnowledgePrincipleFlow = {
  steps: [
    { title: '输入信号', description: '接入话音或数据业务，核对业务接口与输入电平。' },
    { title: '信号处理', description: '按照工作模式完成编码、调制和信道处理。' },
    { title: '射频传输', description: '经功率放大及天线系统发送信号，工作频率须处于允许频段。' },
    { title: '接收还原', description: '完成滤波、解调和业务还原，结合运行指标检查通信质量。' },
  ],
};
