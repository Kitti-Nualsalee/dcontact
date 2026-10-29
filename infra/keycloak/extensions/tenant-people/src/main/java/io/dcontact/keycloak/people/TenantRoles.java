package io.dcontact.keycloak.people;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RoleModel;

final class TenantRoles {
  private TenantRoles() {}

  private static Map<String,RoleModel> validated(RealmModel realm) {
    Map<String,RoleModel> roles=new HashMap<>();
    Set<String> ids=new HashSet<>();
    for(String name:List.of("agent","supervisor","admin")) {
      RoleModel role=realm.getRole(name);
      if(role==null||role.isClientRole()||!realm.getId().equals(role.getContainerId())
        ||!name.equals(role.getName())||role.getId()==null||!ids.add(role.getId()))return Map.of();
      roles.put(name,role);
    }
    Map<String,List<RoleModel>> children=new HashMap<>();
    for(var entry:roles.entrySet()) {
      List<RoleModel> edges=entry.getValue().getCompositesStream().limit(2).toList();
      if(entry.getValue().isComposite()!=!edges.isEmpty())return Map.of();
      children.put(entry.getKey(),edges);
    }
    if(children.values().stream().allMatch(List::isEmpty))return roles;
    for(String name:List.of("agent","supervisor","admin")) {
      List<RoleModel> edges=children.get(name);
      if("agent".equals(name)) {
        if(!edges.isEmpty())return Map.of();
      } else {
        RoleModel expected=roles.get("admin".equals(name)?"supervisor":"agent");
        if(edges.size()!=1)return Map.of();
        RoleModel child=edges.get(0);
        if(child.isClientRole()||!realm.getId().equals(child.getContainerId())
          ||!expected.getName().equals(child.getName())||!expected.getId().equals(child.getId()))return Map.of();
      }
    }
    return roles;
  }

  static Set<String> effectiveRoleIds(RealmModel realm,RoleModel desired) {
    Map<String,RoleModel> roles=validated(realm);
    if(desired==null||desired.isClientRole()||!realm.getId().equals(desired.getContainerId()))return Set.of();
    RoleModel registered=roles.get(desired.getName());
    if(registered==null||!registered.getId().equals(desired.getId()))return Set.of();
    Set<String> result=new HashSet<>();
    result.add(registered.getId());
    if(registered.isComposite()) {
      result.add(roles.get("agent").getId());
      if("admin".equals(registered.getName()))result.add(roles.get("supervisor").getId());
    }
    return Set.copyOf(result);
  }

  static boolean valid(RealmModel realm,RoleModel desired) {
    return !effectiveRoleIds(realm,desired).isEmpty();
  }
}
