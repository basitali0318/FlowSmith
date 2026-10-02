declare module 'bpmn-moddle';
declare module 'pdf-parse/lib/pdf-parse.js' {
  const fn: (data: Buffer) => Promise<{ text: string }>;
  export default fn;
}
