import * as React from "react";
import { useWindowDimensions, View } from "react-native";

export function NativeSafeAreaProvider({ children, style, onInsetsChange }) {
  const window = useWindowDimensions();

  React.useEffect(() => {
    if (typeof onInsetsChange !== "function") {
      return;
    }

    onInsetsChange({
      nativeEvent: {
        insets: {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
        },
        frame: {
          x: 0,
          y: 0,
          width: window.width,
          height: window.height,
        },
      },
    });
  }, [onInsetsChange, window.height, window.width]);

  return <View style={style}>{children}</View>;
}
