import {
  RichText,
  useBridgeState,
  useEditorBridge,
  useEditorContent,
} from "@10play/tentap-editor";
import { prose } from "@robelest/convex-embedded/crdt";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { colors } from "@/src/theme";

type RichTextContent = Record<string, unknown>;

interface RichTextEditorProps {
  content?: RichTextContent;
  placeholder?: string;
  editable?: boolean;
  style?: StyleProp<ViewStyle>;
  onChange?: (content: RichTextContent) => Promise<void> | void;
}

const EMPTY_CONTENT: RichTextContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const EDITOR_CSS = `
  body,
  .ProseMirror,
  .ProseMirror p,
  .ProseMirror li,
  .ProseMirror blockquote,
  .ProseMirror code,
  .ProseMirror pre {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${colors.warm[700]};
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif !important;
    font-size: 15px !important;
    line-height: 24px !important;
    font-weight: 400 !important;
    letter-spacing: 0 !important;
    -webkit-text-size-adjust: 100%;
  }
  .ProseMirror {
    min-height: 100%;
    padding: 4px 8px 12px;
    outline: none;
    caret-color: ${colors.warm[700]};
  }
  .ProseMirror p {
    margin: 0;
  }
  .ProseMirror p + p {
    margin-top: 8px;
  }
  .ProseMirror ul,
  .ProseMirror ol {
    margin: 4px 0;
    padding-left: 20px;
  }
  .ProseMirror blockquote {
    margin: 8px 0;
    padding-left: 12px;
    border-left: 2px solid ${colors.warm[300]};
    color: ${colors.warm[600]};
    font-style: italic;
  }
  .ProseMirror code {
    background: ${colors.warm[200]};
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 13px;
  }
  .ProseMirror pre {
    background: ${colors.warm[100]};
    border-radius: 4px;
    padding: 12px;
    overflow-x: auto;
    font-size: 13px;
  }
  .ProseMirror h1 { font-size: 20px; font-weight: 600; margin: 0; }
  .ProseMirror h2 { font-size: 17px; font-weight: 600; margin: 0; }
  .ProseMirror h3 { font-size: 15px; font-weight: 600; margin: 0; }
`;

function normalizeContent(content?: RichTextContent): RichTextContent {
  if (!content || Array.isArray(content)) {
    return EMPTY_CONTENT;
  }

  return content;
}

export default function RichTextEditor({
  content,
  placeholder = "",
  editable = true,
  style,
  onChange,
}: RichTextEditorProps) {
  const [showPreview, setShowPreview] = useState(true);
  const normalizedContent = useMemo(() => normalizeContent(content), [content]);
  const previewText = useMemo(
    () => prose.text(normalizedContent),
    [normalizedContent],
  );
  const serializedContent = useMemo(
    () => JSON.stringify(normalizedContent),
    [normalizedContent],
  );
  const lastAppliedContent = useRef(serializedContent);
  const previewOpacity = useRef(new Animated.Value(1)).current;
  const hidePreviewTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: true,
    editable,
    initialContent: normalizedContent,
    theme: {
      webview: {
        backgroundColor: "transparent",
      },
      webviewContainer: {
        backgroundColor: "transparent",
      },
    },
  });
  const editorContent = useEditorContent(editor, {
    type: "json",
    debounceInterval: 120,
  });
  const editorState = useBridgeState(editor);

  useLayoutEffect(() => {
    if (!editorState.isReady) {
      return;
    }

    const timeout = setTimeout(() => {
      setShowPreview(false);
    }, 80);

    return () => clearTimeout(timeout);
  }, [editorState.isReady]);

  useLayoutEffect(() => {
    if (!showPreview) {
      return;
    }

    const fallback = setTimeout(() => {
      setShowPreview(false);
    }, 900);

    return () => clearTimeout(fallback);
  }, [showPreview]);

  useLayoutEffect(() => {
    if (showPreview) {
      previewOpacity.setValue(1);
      return;
    }

    Animated.timing(previewOpacity, {
      toValue: 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [previewOpacity, showPreview]);

  useLayoutEffect(() => {
    if (!editorState.isReady) {
      return;
    }

    editor.injectCSS(EDITOR_CSS);
    editor.setEditable(editable);
    editor.setPlaceholder(placeholder);
  }, [editable, editor, editorState.isReady, placeholder]);

  useLayoutEffect(() => {
    if (!editorState.isReady) {
      return;
    }

    editor.setEditable(editable);
  }, [editable, editor, editorState.isReady]);

  useLayoutEffect(() => {
    if (!editorState.isReady) {
      return;
    }

    editor.setPlaceholder(placeholder);
  }, [editor, editorState.isReady, placeholder]);

  useLayoutEffect(() => {
    if (
      !editorState.isReady ||
      serializedContent === lastAppliedContent.current
    ) {
      return;
    }

    lastAppliedContent.current = serializedContent;
    editor.setContent(normalizedContent);
  }, [editor, editorState.isReady, normalizedContent, serializedContent]);

  useLayoutEffect(() => {
    if (!editorContent || Array.isArray(editorContent)) {
      return;
    }

    const serializedEditorContent = JSON.stringify(editorContent);
    if (serializedEditorContent === lastAppliedContent.current) {
      return;
    }

    lastAppliedContent.current = serializedEditorContent;
    void onChange?.(editorContent as RichTextContent);
  }, [editorContent, onChange]);

  useLayoutEffect(() => {
    return () => {
      if (hidePreviewTimeout.current) {
        clearTimeout(hidePreviewTimeout.current);
      }
    };
  }, []);

  return (
    <View style={[styles.container, style]}>
      {showPreview && (
        <Animated.View
          pointerEvents="none"
          style={[styles.preview, { opacity: previewOpacity }]}
        >
          <Text style={styles.previewText}>{previewText}</Text>
        </Animated.View>
      )}
      <RichText editor={editor} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "transparent",
  },
  preview: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.white,
    justifyContent: "flex-start",
  },
  previewText: {
    fontFamily: "System",
    fontSize: 15,
    lineHeight: 24,
    color: colors.warm[700],
    paddingHorizontal: 8,
    paddingTop: 4,
    fontWeight: "400",
  },
});
