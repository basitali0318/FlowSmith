import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

export interface CanvasHandle {
  getXml(): Promise<string>;
  getSvg(): Promise<string>;
  fit(): void;
  zoom(delta: number): void;
}

interface Props {
  xml: string | null;
  highlight: string[];
  onDirty: () => void;
  onError: (msg: string) => void;
}

function fitView(m: any) {
  const canvas = m.get('canvas');
  canvas.resized();
  canvas.zoom('fit-viewport', 'auto');
  canvas.scroll({ dx: 36, dy: 0 }); // keep clear of the editing palette
}

const BpmnCanvas = forwardRef<CanvasHandle, Props>(function BpmnCanvas({ xml, highlight, onDirty, onError }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const modeler = useRef<any>(null);
  const marked = useRef<string[]>([]);
  const loading = useRef(false);
  const dirtyCb = useRef(onDirty);
  dirtyCb.current = onDirty;

  useEffect(() => {
    const m = new BpmnModeler({ container: host.current! });
    modeler.current = m;
    m.on('commandStack.changed', () => { if (!loading.current) dirtyCb.current(); });
    const ro = new ResizeObserver(() => { try { m.get('canvas').resized(); } catch { /* not ready */ } });
    ro.observe(host.current!);
    return () => { ro.disconnect(); m.destroy(); };
  }, []);

  useEffect(() => {
    const m = modeler.current;
    if (!m || !xml) return;
    loading.current = true;
    m.importXML(xml)
      .then(() => fitView(m))
      .catch((e: Error) => onError(`Could not render diagram: ${e.message}`))
      .finally(() => { setTimeout(() => { loading.current = false; }, 0); });
  }, [xml, onError]);

  useEffect(() => {
    const m = modeler.current;
    if (!m) return;
    try {
      const canvas = m.get('canvas');
      marked.current.forEach((id) => { try { canvas.removeMarker(id, 'fs-hl'); } catch { /* element removed */ } });
      const ok = highlight.filter((id) => m.get('elementRegistry').get(id));
      ok.forEach((id) => canvas.addMarker(id, 'fs-hl'));
      marked.current = ok;
    } catch { /* diagram not loaded yet */ }
  }, [highlight, xml]);

  useImperativeHandle(ref, () => ({
    async getXml() { return (await modeler.current.saveXML({ format: true })).xml as string; },
    async getSvg() { return (await modeler.current.saveSVG()).svg as string; },
    fit() { if (modeler.current) fitView(modeler.current); },
    zoom(delta: number) { const c = modeler.current?.get('canvas'); if (c) c.zoom(c.zoom() * (1 + delta)); },
  }));

  return <div className="canvas" ref={host} />;
});

export default BpmnCanvas;
