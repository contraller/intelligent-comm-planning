import type { DiagnosisFile, DiagnosisRecord, ReportFormat } from '../types/diagnosis';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { diagnosisReportSections } from './diagnosis-report';
import { diagnosisFigurePng, diagnosisFigureSvg } from './diagnosis-figure';

const cleanName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0,80);
let cachedFont: Uint8Array | undefined;
async function reportFont() {
  if (cachedFont) return cachedFont;
  const response = await fetch(`${import.meta.env.BASE_URL}fonts/NotoSansCJKsc-Regular.otf`);
  if (!response.ok) throw new Error(`报告中文字体加载失败（${response.status}）`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0,4)) !== 'OTTO') throw new Error('报告字体内容无效');
  cachedFont = bytes; return bytes;
}
function base64(bytes: Uint8Array) {
  let value = ''; for (let index = 0; index < bytes.length; index += 8192) value += String.fromCharCode(...bytes.subarray(index,index+8192));
  return btoa(value);
}
// 导出只消费统一报告快照；依赖按需载入，字体和图片可显式注入进行自检。
export async function createDiagnosisExport(record: DiagnosisRecord, format: ReportFormat, options: { fontBytes?: Uint8Array; figurePng?: Uint8Array; exportedAt?: string } = {}): Promise<DiagnosisFile> {
  const name = `${cleanName(record.name)}-${record.id.slice(0,12)}.${format}`;
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  if (format === 'json') return { name, mime: 'application/json;charset=utf-8', bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, exportedAt, ...record }, null, 2)) };
  const sections = diagnosisReportSections(record);
  if (format === 'pdf') {
    const pdfMake = (await import('pdfmake/build/pdfmake')).default;
    const bytes = options.fontBytes ?? await reportFont();
    pdfMake.addVirtualFileSystem({ 'Report.otf': base64(bytes) });
    pdfMake.addFonts({ Report: { normal:'Report.otf', bold:'Report.otf', italics:'Report.otf', bolditalics:'Report.otf' } });
    const content: Content[] = [{ text: `${record.name}诊断报告`, fontSize: 22, margin:[0,0,0,10] }, { text: `导出时间：${exportedAt}`, color:'#61738a', fontSize:9 }, { svg: diagnosisFigureSvg(record), width:495, margin:[0,12,0,12] }];
    for (const section of sections) {
      content.push({ text: section.title, fontSize:14, color:'#193b60', margin:[0,15,0,7], headlineLevel:1 });
      for (const line of section.text) content.push({ text:line, margin:[0,2,0,5] });
      // 长依据列多分配宽度，表头至少与两行正文一起分页。
      const widths = section.headers.length === 2 ? [135,'*'] : section.headers[1] === '结论 / 依据' ? [55,'*',55,75] : section.headers.map(() => '*');
      if (section.headers.length) content.push({ table: { headerRows:1, keepWithHeaderRows:Math.min(2,section.rows.length), widths, body:[section.headers.map((text) => ({text,fillColor:'#e6eef6'})), ...section.rows] }, layout:'lightHorizontalLines', fontSize:9, margin:[0,3,0,5] });
    }
    const definition: TDocumentDefinitions = { pageSize:'A4', pageMargins:[45,48,45,48], defaultStyle:{font:'Report',fontSize:10,lineHeight:1.3}, content,
      header:{text:'无线网络智能规划系统 · 教学演示诊断报告',fontSize:8,color:'#61738a',margin:[45,22,45,0]},
      footer:(page,total) => ({ text:`预生成快照 · ${page} / ${total}`,fontSize:8,alignment:'center',margin:[0,12,0,0] }),
      pageBreakBefore:(node,container) => node.headlineLevel === 1 && ((node.startPosition?.top ?? 0) > 680 || container.getFollowingNodesOnPage().length === 0),
    };
    return { name, mime:'application/pdf', bytes:new Uint8Array(await pdfMake.createPdf(definition).getBuffer()) };
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, Footer, PageNumber, AlignmentType } = await import('docx');
  const png = options.figurePng ?? await diagnosisFigurePng(record);
  const paragraph = (text: string) => new Paragraph({ children:[new TextRun({text,font:{ascii:'Arial',eastAsia:'Microsoft YaHei'}})] });
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [new Paragraph({text:`${record.name}诊断报告`,heading:HeadingLevel.TITLE}),paragraph(`导出时间：${exportedAt}`),new Paragraph({children:[new ImageRun({type:'png',data:png,transformation:{width:650,height:383}})]})];
  for (const section of sections) {
    children.push(new Paragraph({text:section.title,heading:HeadingLevel.HEADING_1,keepNext:true}));
    children.push(...section.text.map(paragraph));
    if (section.headers.length) children.push(new Table({ width:{size:100,type:WidthType.PERCENTAGE}, rows:[section.headers,...section.rows].map((row,index) => new TableRow({tableHeader:index === 0,children:row.map((cell) => new TableCell({children:cell.split('\n').map(paragraph),shading:index === 0 ? {fill:'E6EEF6'} : undefined}))})) }));
  }
  const doc = new Document({ styles:{default:{document:{run:{font:'Microsoft YaHei',size:20},paragraph:{spacing:{after:120}}}}}, sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:900,bottom:900,left:900,right:900}}},footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun('教学演示 · '),new TextRun({children:[PageNumber.CURRENT]})]})]})},children}] });
  return {name,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:new Uint8Array(await Packer.toArrayBuffer(doc))};
}
export function downloadDiagnosisFile(file: DiagnosisFile) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes).buffer], { type:file.mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
