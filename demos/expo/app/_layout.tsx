import { DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { ConvexProvider } from "convex/react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { EmbeddedClientProvider, getClient } from "@/src/convex-client";
import { ProjectSelectionProvider } from "@/src/project-selection";

import "react-native-reanimated";

const WarmTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: "#c25d3a",
    background: "#fdfcfa",
    card: "#ffffff",
    text: "#1a1816",
    border: "#e8e2d8",
    notification: "#c25d3a",
  },
};

const TRANSPARENT_SHEET_OPTIONS = {
  presentation: "transparentModal",
  animation: "none",
  contentStyle: { backgroundColor: "transparent" },
} as const;

export default function RootLayout() {
  const [client] = React.useState(() => getClient());

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ConvexProvider client={client}>
          <EmbeddedClientProvider client={client}>
            <ThemeProvider value={WarmTheme}>
              <ProjectSelectionProvider>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="index" />
                  <Stack.Screen
                    name="project/[id]"
                    options={TRANSPARENT_SHEET_OPTIONS}
                  />
                  <Stack.Screen
                    name="issue/[id]"
                    options={TRANSPARENT_SHEET_OPTIONS}
                  />
                </Stack>
              </ProjectSelectionProvider>
              <StatusBar style="dark" />
            </ThemeProvider>
          </EmbeddedClientProvider>
        </ConvexProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
