import { DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { ConvexProvider } from "convex/react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { client } from "@/src/convex-client";

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

export default function RootLayout() {
  return (
    <ConvexProvider client={client}>
      <ThemeProvider value={WarmTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen
            name="issue/[id]"
            options={{
              presentation: "formSheet",
              sheetGrabberVisible: true,
              sheetAllowedDetents: [0.85, 1.0],
            }}
          />
        </Stack>
        <StatusBar style="dark" />
      </ThemeProvider>
    </ConvexProvider>
  );
}
