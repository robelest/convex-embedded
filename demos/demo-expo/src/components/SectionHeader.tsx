import React from "react";
import { View, Text, StyleSheet } from "react-native";

import { colors } from "@/src/theme";

export function SectionHeader({
  title,
  count,
}: {
  title: string;
  count: number;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.count}>{count}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.warm[50],
  },
  title: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1.6,
    color: colors.warm[500],
  },
  count: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.warm[400],
  },
});
