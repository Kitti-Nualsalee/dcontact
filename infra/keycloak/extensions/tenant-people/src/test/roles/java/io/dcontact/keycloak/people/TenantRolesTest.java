package io.dcontact.keycloak.people;

import java.lang.reflect.Proxy;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.stream.Stream;
import org.keycloak.models.ClientModel;
import org.keycloak.models.ClientProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RoleModel;
import org.keycloak.models.UserModel;
import org.keycloak.organization.OrganizationProvider;

public final class TenantRolesTest {
  private static final String REALM="tenant-realm";
  private static int assertions;

  private static final class Fixture {
    final Map<String,RoleModel> roles=new HashMap<>();
    final Map<String,List<RoleModel>> children=new HashMap<>();
    final RealmModel realm=(RealmModel)Proxy.newProxyInstance(RealmModel.class.getClassLoader(),new Class<?>[]{RealmModel.class},(proxy,method,arguments)->switch(method.getName()) {
      case "getId" -> REALM;
      case "getRole" -> roles.get((String)arguments[0]);
      case "getRolesStream" -> roles.values().stream();
      default -> throw new UnsupportedOperationException(method.getName());
    });

    Fixture(boolean hierarchy) {
      for(String name:List.of("agent","supervisor","admin"))roles.put(name,role(name,name,REALM,false));
      if(hierarchy) {
        children.get("admin").add(roles.get("supervisor"));
        children.get("supervisor").add(roles.get("agent"));
      }
    }

    RoleModel role(String name,String id,String container,boolean clientRole) {
      children.putIfAbsent(id,new ArrayList<>());
      return (RoleModel)Proxy.newProxyInstance(RoleModel.class.getClassLoader(),new Class<?>[]{RoleModel.class},(proxy,method,arguments)->switch(method.getName()) {
        case "getId" -> id;
        case "getName" -> name;
        case "getContainerId" -> container;
        case "isClientRole" -> clientRole;
        case "isComposite" -> !children.get(id).isEmpty();
        case "getCompositesStream" -> children.get(id).stream();
        default -> throw new UnsupportedOperationException(method.getName());
      });
    }
  }

  private static void check(boolean condition,String name) {
    assertions++;
    if(!condition)throw new AssertionError(name);
  }

  private static boolean identityMatches(Fixture fixture,String requested,List<RoleModel> direct,boolean bootstrap) throws Exception {
    OrganizationModel organization=(OrganizationModel)Proxy.newProxyInstance(OrganizationModel.class.getClassLoader(),new Class<?>[]{OrganizationModel.class},(proxy,method,arguments)->switch(method.getName()) {
      case "getId" -> "organization";
      case "getAlias" -> "tenant";
      default -> throw new UnsupportedOperationException(method.getName());
    });
    ClientModel client=(ClientModel)Proxy.newProxyInstance(ClientModel.class.getClassLoader(),new Class<?>[]{ClientModel.class},(proxy,method,arguments)->switch(method.getName()) {
      case "getAttribute" -> "dc_verified_bootstrap_admins".equals(arguments[0])&&bootstrap?"domain-user:identity":null;
      default -> throw new UnsupportedOperationException(method.getName());
    });
    ClientProvider clients=(ClientProvider)Proxy.newProxyInstance(ClientProvider.class.getClassLoader(),new Class<?>[]{ClientProvider.class},(proxy,method,arguments)->switch(method.getName()) {
      case "getClientByClientId" -> null;
      default -> throw new UnsupportedOperationException(method.getName());
    });
    OrganizationProvider organizations=(OrganizationProvider)Proxy.newProxyInstance(OrganizationProvider.class.getClassLoader(),new Class<?>[]{OrganizationProvider.class},(proxy,method,arguments)->switch(method.getName()) {
      case "getByMember" -> Stream.of(organization);
      default -> throw new UnsupportedOperationException(method.getName());
    });
    KeycloakSession session=(KeycloakSession)Proxy.newProxyInstance(KeycloakSession.class.getClassLoader(),new Class<?>[]{KeycloakSession.class},(proxy,method,arguments)->switch(method.getName()) {
      case "clients" -> clients;
      case "getProvider" -> organizations;
      default -> throw new UnsupportedOperationException(method.getName());
    });
    Map<String,String> attributes=bootstrap?Map.of():Map.of("dc_identity_class","TENANT_USER","tenant_id","tenant-id","tenant_slug","tenant","dc_user_id","domain-user");
    UserModel user=(UserModel)Proxy.newProxyInstance(UserModel.class.getClassLoader(),new Class<?>[]{UserModel.class},(proxy,method,arguments)->switch(method.getName()) {
      case "getId" -> "identity";
      case "getServiceAccountClientLink" -> null;
      case "getFirstAttribute" -> attributes.get((String)arguments[0]);
      case "getRoleMappingsStream" -> direct.stream();
      case "hasRole" -> {
        Set<String> seen=new HashSet<>();
        List<RoleModel> pending=new ArrayList<>(direct);
        while(!pending.isEmpty()) {
          RoleModel role=pending.remove(pending.size()-1);
          if(seen.add(role.getId()))pending.addAll(fixture.children.get(role.getId()));
        }
        yield seen.contains(((RoleModel)arguments[0]).getId());
      }
      default -> throw new UnsupportedOperationException(method.getName());
    });
    Method method=PeopleDisableResource.class.getDeclaredMethod("identityMatches",PeopleResource.Binding.class,String.class,String.class,UserModel.class,String.class);
    method.setAccessible(true);
    return (boolean)method.invoke(new PeopleDisableResource(session,new PeopleResource(session)),new PeopleResource.Binding(fixture.realm,client,organization),"tenant-id","domain-user",user,requested);
  }

  public static void main(String[] arguments) throws Exception {
    Fixture canonical=new Fixture(true);
    for(String role:List.of("agent","supervisor","admin"))check(TenantRoles.valid(canonical.realm,canonical.roles.get(role)),"canonical "+role);
    check(TenantRoles.effectiveRoleIds(canonical.realm,canonical.roles.get("admin")).equals(Set.of("admin","supervisor","agent")),"admin inheritance");
    check(TenantRoles.effectiveRoleIds(canonical.realm,canonical.roles.get("supervisor")).equals(Set.of("supervisor","agent")),"supervisor inheritance");
    check(TenantRoles.effectiveRoleIds(canonical.realm,canonical.roles.get("agent")).equals(Set.of("agent")),"agent does not inherit higher roles");
    Fixture flat=new Fixture(false);
    for(String role:List.of("agent","supervisor","admin"))check(TenantRoles.valid(flat.realm,flat.roles.get(role)),"legacy leaf "+role);
    check(TenantRoles.effectiveRoleIds(flat.realm,flat.roles.get("admin")).equals(Set.of("admin")),"leaf does not invent inherited grants");
    check(!TenantRoles.valid(canonical.realm,null),"missing desired");
    for(String extra:List.of("platform_admin","service","realm-admin","create-realm","unexpected")) {
      Fixture poisoned=new Fixture(true);
      poisoned.children.get("agent").add(poisoned.role(extra,extra,REALM,false));
      for(String role:List.of("agent","supervisor","admin"))check(!TenantRoles.valid(poisoned.realm,poisoned.roles.get(role)),"poisoned "+extra+" "+role);
    }
    Fixture cycle=new Fixture(true);
    cycle.children.get("agent").add(cycle.roles.get("admin"));
    check(!TenantRoles.valid(cycle.realm,cycle.roles.get("admin")),"cycle");
    Fixture foreign=new Fixture(true);
    foreign.roles.put("agent",foreign.role("agent","foreign-agent","another-realm",false));
    check(!TenantRoles.valid(foreign.realm,foreign.roles.get("admin")),"foreign realm");
    Fixture client=new Fixture(true);
    client.roles.put("agent",client.role("agent","client-agent",REALM,true));
    check(!TenantRoles.valid(client.realm,client.roles.get("admin")),"client role");
    Fixture duplicate=new Fixture(true);
    duplicate.roles.put("agent",duplicate.role("agent","admin",REALM,false));
    check(!TenantRoles.valid(duplicate.realm,duplicate.roles.get("admin")),"duplicate role id");
    Fixture impersonated=new Fixture(true);
    impersonated.children.get("supervisor").clear();
    impersonated.children.get("supervisor").add(impersonated.role("agent","other-agent",REALM,false));
    check(!TenantRoles.valid(impersonated.realm,impersonated.roles.get("admin")),"same name different id");
    Fixture partial=new Fixture(true);
    partial.children.get("supervisor").clear();
    check(!TenantRoles.valid(partial.realm,partial.roles.get("admin")),"partial hierarchy");
    check(!TenantRoles.valid(canonical.realm,canonical.role("admin","unregistered-admin",REALM,false)),"unregistered desired");
    for(String name:List.of("agent","supervisor","admin"))check(identityMatches(canonical,name.toUpperCase(java.util.Locale.ROOT),List.of(canonical.roles.get(name)),false),"disable canonical "+name);
    check(!identityMatches(canonical,"SUPERVISOR",List.of(canonical.roles.get("admin")),false),"inherited lower role cannot replace direct domain role");
    check(!identityMatches(canonical,"ADMIN",List.of(canonical.roles.get("agent")),false),"agent cannot become admin");
    check(!identityMatches(canonical,"ADMIN",List.of(canonical.roles.get("admin"),canonical.roles.get("agent")),false),"multiple direct tenant roles rejected");
    Fixture bootstrap=new Fixture(true);
    RoleModel defaultRole=bootstrap.role("default-roles-tenant","default",REALM,false);
    bootstrap.roles.put("default-roles-tenant",defaultRole);
    check(identityMatches(bootstrap,"ADMIN",List.of(bootstrap.roles.get("admin"),defaultRole),true),"enrolled bootstrap admin with safe default role");
    for(String protectedName:List.of("service","platform_admin","realm-admin","create-realm")) {
      RoleModel protectedRole=bootstrap.role(protectedName,protectedName,REALM,false);
      bootstrap.roles.put(protectedName,protectedRole);
      bootstrap.children.get("default").add(protectedRole);
      check(!identityMatches(bootstrap,"ADMIN",List.of(bootstrap.roles.get("admin"),defaultRole),true),"default role cannot inherit "+protectedName);
      bootstrap.children.get("default").clear();
    }
    System.out.println("TENANT_ROLE_GRAPH_PASS assertions="+assertions);
  }
}
