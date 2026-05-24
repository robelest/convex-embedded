import { useRouter } from "expo-router";
import React from "react";
import {
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "@/src/theme";

const SCREEN_HEIGHT = Dimensions.get("window").height;

const ENTER_SPRING = {
  mass: 1,
  damping: 32,
  stiffness: 320,
  overshootClamping: false,
  restDisplacementThreshold: 0.5,
  restSpeedThreshold: 0.5,
} as const;

const SNAP_SPRING = {
  mass: 1,
  damping: 26,
  stiffness: 260,
} as const;

const EXIT_TIMING = { duration: 200 } as const;

const DISMISS_FRACTION = 0.32;
const DISMISS_VELOCITY = 900;

interface SheetProps {
  detents?: readonly number[];
  initialDetent?: number;
  onDismiss?: () => void;
  showGrabber?: boolean;
  children: React.ReactNode;
}

export function Sheet({
  detents = [0.85],
  initialDetent,
  onDismiss,
  showGrabber = true,
  children,
}: SheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const sorted = React.useMemo(
    () => [...detents].sort((a, b) => a - b),
    [detents],
  );
  const initial = initialDetent ?? sorted[0]!;
  const closedY = SCREEN_HEIGHT;
  const snapYs = React.useMemo(
    () => sorted.map((d) => SCREEN_HEIGHT * (1 - d)),
    [sorted],
  );
  const openY = SCREEN_HEIGHT * (1 - initial);
  const maxOpenY = snapYs[snapYs.length - 1]!;

  const translateY = useSharedValue(closedY);
  const startY = useSharedValue(0);

  React.useLayoutEffect(() => {
    translateY.value = withSpring(openY, ENTER_SPRING);
  }, [openY, translateY]);

  const handleDismissed = React.useCallback(() => {
    if (onDismiss) {
      onDismiss();
    } else if (router.canGoBack()) {
      router.back();
    }
  }, [onDismiss, router]);

  const dismiss = React.useCallback(() => {
    Keyboard.dismiss();
    translateY.value = withTiming(closedY, EXIT_TIMING, (finished) => {
      if (finished) {
        runOnJS(handleDismissed)();
      }
    });
  }, [closedY, handleDismissed, translateY]);

  const pan = React.useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          startY.value = translateY.value;
        })
        .onUpdate((e) => {
          const next = startY.value + e.translationY;
          if (next < maxOpenY) {
            const overshoot = maxOpenY - next;
            translateY.value = maxOpenY - overshoot * 0.25;
          } else {
            translateY.value = next;
          }
        })
        .onEnd((e) => {
          const projected = translateY.value + e.velocityY * 0.12;
          const dismissThreshold = openY + (closedY - openY) * DISMISS_FRACTION;
          if (projected > dismissThreshold || e.velocityY > DISMISS_VELOCITY) {
            runOnJS(dismiss)();
            return;
          }
          let target = snapYs[0]!;
          let bestDelta = Math.abs(projected - target);
          for (const sp of snapYs) {
            const delta = Math.abs(projected - sp);
            if (delta < bestDelta) {
              bestDelta = delta;
              target = sp;
            }
          }
          translateY.value = withSpring(target, SNAP_SPRING);
        }),
    [closedY, dismiss, maxOpenY, openY, snapYs, startY, translateY],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateY.value,
      [closedY, openY],
      [0, 0.42],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        pointerEvents="none"
        style={[styles.backdrop, backdropStyle]}
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={dismiss}
        accessibilityLabel="Dismiss sheet"
      />
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.sheet,
            {
              height: SCREEN_HEIGHT,
              paddingBottom: insets.bottom,
            },
            sheetStyle,
          ]}
        >
          {showGrabber ? (
            <View style={styles.grabberContainer}>
              <View style={styles.grabber} />
            </View>
          ) : (
            <View style={{ height: insets.top > 0 ? 12 : 8 }} />
          )}
          <View style={styles.content}>{children}</View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: colors.warm[50],
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderCurve: "continuous",
    overflow: "hidden",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: -6 },
      },
      android: { elevation: 16 },
    }),
  },
  grabberContainer: {
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 6,
  },
  grabber: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.warm[300],
  },
  content: { flex: 1 },
});
