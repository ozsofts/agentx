import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Follow output only while the reader stays at the end. Observe layout changes
// as well as tokens (images, process folding and window resizing change height).
export default function useThreadScroll({ sessionId, messages, running, visible }) {
  const threadRef = useRef(null);
  const contentRef = useRef(null);
  const following = useRef(true);
  const layout = useRef({});
  const previousSession = useRef(sessionId);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  const followBottom = useCallback(() => {
    const thread = threadRef.current;
    if (!thread?.clientHeight) return;
    layout.current = { height: thread.clientHeight, width: thread.clientWidth, content: thread.scrollHeight };
    if (!following.current) return;
    thread.scrollTop = thread.scrollHeight;
    setAwayFromBottom(false);
  }, []);

  const onScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread?.clientHeight) return;
    // Resizing can dispatch a scroll event before ResizeObserver runs. Do not
    // mistake the newly smaller viewport for the reader scrolling up.
    if (following.current && (layout.current.height !== thread.clientHeight || layout.current.width !== thread.clientWidth || layout.current.content !== thread.scrollHeight)) {
      followBottom();
      return;
    }
    const atBottom = thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 48;
    following.current = atBottom;
    setAwayFromBottom(!atBottom);
  }, [followBottom]);

  const jumpToBottom = useCallback(() => {
    following.current = true;
    followBottom();
  }, [followBottom]);

  useLayoutEffect(() => {
    if (previousSession.current !== sessionId) {
      previousSession.current = sessionId;
      following.current = true;
      setAwayFromBottom(false);
    }
    if (visible) followBottom();
  }, [sessionId, messages, running, visible, followBottom]);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(followBottom);
    observer.observe(threadRef.current);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [followBottom]);

  return { threadRef, contentRef, onScroll, awayFromBottom, jumpToBottom };
}
