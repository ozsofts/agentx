import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowBendDownRight, ArrowUp, DotsThree, FileText, ListChecks, PencilSimple, Trash, X } from "@phosphor-icons/react";
import Modal from "./Modal.jsx";

export default function QueuedInputs({ entries, running, hasDraft, onResume, onRemove, onBehavior }) {
  const [menu, setMenu] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);
  const popup = useRef(null);
  const trigger = useRef(null);
  const selected = entries.find((entry) => entry.id === menu?.id);
  useEffect(() => {
    if (!menu) return;
    if (!selected) { setMenu(null); return; }
    popup.current?.querySelector('button:not(:disabled)')?.focus();
    const outside = (event) => { if (!popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) setMenu(null); };
    const close = (event) => { if (!popup.current?.contains(event.target)) setMenu(null); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, Boolean(selected)]);
  const act = async (entry, operation) => {
    setMenu(null); setBusy(entry.id);
    try { await operation(); } finally { setBusy(null); }
  };
  const menuKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); setMenu(null); trigger.current?.focus(); }
    if (event.key === "Tab") setMenu(null);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...popup.current.querySelectorAll('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <>
    {entries.length > 0 && <section className="input-queue" aria-label={`待处理消息，${entries.length} 条`}>
      <div className="input-queue-list">{entries.map((entry) => {
        const blocked = entry.status === "delivering" || busy === entry.id;
        const paused = entry.status === "held";
        return <div className={`input-queue-item is-${entry.status}`} key={entry.id} data-input-id={entry.id}>
          <ListChecks size={16} className="input-queue-icon" aria-hidden="true" />
          <p className="input-queue-text" title={entry.text}>{entry.text}</p>
          {entry.attachments?.length > 0 && <span className="input-queue-attachment" title={entry.attachments.map((item) => item.name).join("、")}><FileText size={13} />{entry.attachments.length}</span>}
          {paused && <span className="input-queue-label" title={entry.reason}>已暂停</span>}
          <div className="input-queue-actions">
            {paused ? <button type="button" className="queue-primary-action" disabled={blocked || running} onClick={() => act(entry, () => onResume(entry))} title="继续发送" aria-label="继续发送待处理消息"><ArrowUp size={15} /><span>发送</span></button>
              : <button type="button" className="queue-primary-action" disabled={blocked || entry.behavior === "steer"} onClick={() => act(entry, () => onBehavior(entry, "steer"))} title={blocked ? "消息正在被接收" : entry.behavior === "steer" ? "将在当前轮次的工具调用完成后介入，可在更多菜单中改回排队" : "改为补充当前任务，在当前轮次的工具调用完成后介入"} aria-label="将待处理消息改为 Steer"><ArrowBendDownRight size={16} /><span>{entry.status === "delivering" ? "接收中" : "Steer"}</span></button>}
            <button type="button" disabled={blocked} onClick={() => act(entry, () => onRemove(entry))} title="取消这条待处理消息" aria-label="移除待处理消息"><Trash size={16} /></button>
            <button type="button" aria-label="待处理消息更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={menu?.id === entry.id} onClick={(event) => {
              trigger.current = event.currentTarget;
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu(menu?.id === entry.id ? null : { id: entry.id, top: Math.max(8, rect.top - 146), right: Math.max(8, window.innerWidth - rect.right) });
            }}><DotsThree size={20} weight="bold" /></button>
          </div>
        </div>;
      })}</div>
    </section>}
    {menu && selected && createPortal(<div ref={popup} className="input-queue-menu" role="menu" aria-label="待处理消息操作" style={{ top: menu.top, right: menu.right }} onKeyDown={menuKey}>
      <button type="button" role="menuitem" onClick={() => { setDetail(selected); setMenu(null); }}><FileText size={15} />查看完整内容</button>
      <button type="button" role="menuitem" disabled={hasDraft || selected.status === "delivering" || busy === selected.id} title={hasDraft ? "请先发送或清空输入框中的草稿" : "取消排队并移回输入框"} onClick={() => act(selected, () => onRemove(selected, true))}><PencilSimple size={15} />移回输入框编辑</button>
      {selected.behavior === "steer" && <button type="button" role="menuitem" disabled={selected.status === "delivering" || busy === selected.id} onClick={() => act(selected, () => onBehavior(selected, "followUp"))}><ListChecks size={15} />改为等待当前任务完成</button>}
    </div>, document.body)}
    {detail && <Modal onClose={() => setDetail(null)}><section className="small-dialog queued-input-detail" role="dialog" aria-modal="true" aria-labelledby="queued-input-title">
      <header className="small-dialog-header"><h2 id="queued-input-title">待处理消息</h2><button type="button" className="icon-button" onClick={() => setDetail(null)} aria-label="关闭待处理消息详情"><X size={18} /></button></header>
      <div className="queued-input-detail-body"><p>{detail.text}</p>{detail.attachments?.length > 0 && <ul>{detail.attachments.map((item, index) => <li key={item.id || index}>{item.name}</li>)}</ul>}</div>
    </section></Modal>}
  </>;
}
