import React from "react";
import { View, Text, StyleSheet } from "react-native";

import type { Member } from "@/src/data/mock";
import { colors, roleColors } from "@/src/theme";

export function MemberRow({ member }: { member: Member }) {
  return (
    <View style={styles.row}>
      <View
        style={[styles.avatar, { backgroundColor: roleColors[member.role] }]}
      >
        <Text style={styles.avatarText}>{member.name.charAt(0)}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name}>{member.name}</Text>
        <Text style={styles.email}>{member.email}</Text>
      </View>
      <View style={styles.roleBadge}>
        <Text style={styles.roleText}>{member.role}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.white,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.white,
  },
  info: {
    flex: 1,
    marginLeft: 12,
  },
  name: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.warm[900],
  },
  email: {
    fontSize: 13,
    color: colors.warm[500],
  },
  roleBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.warm[100],
    borderWidth: 1,
    borderColor: colors.warm[300],
  },
  roleText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.warm[600],
    textTransform: "capitalize",
  },
});
