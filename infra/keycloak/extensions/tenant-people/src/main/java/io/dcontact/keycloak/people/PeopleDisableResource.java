package io.dcontact.keycloak.people;

import jakarta.persistence.EntityManager;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.OTPCredentialModel;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.storage.UserStoragePrivateUtil;
import static io.dcontact.keycloak.people.PeopleResource.*;

@Produces(MediaType.APPLICATION_JSON)
public class PeopleDisableResource {
  private static final Set<String> FIELDS=Set.of("tenantId","targetUserId","identityId","payloadDigest","fencingToken","role","adminCandidates");
  private final KeycloakSession session;
  private final PeopleResource authority;

  PeopleDisableResource(KeycloakSession session,PeopleResource authority) {
    this.session=session;this.authority=authority;
  }

  private record Candidate(String userId,String identityId) {}
  private record Command(String tenantId,String userId,String identityId,String digest,long fence,String role,List<Candidate> admins,String canonicalAdmins) {}

  private static String text(Map<String,Object> body,String name) {
    Object value=body.get(name);
    if(!(value instanceof String))throw denied(400,"INVALID_REQUEST");
    return (String)value;
  }

  private Command parse(Map<String,Object> body) {
    if(body==null||!body.keySet().equals(FIELDS))throw denied(400,"INVALID_REQUEST");
    String tenant=text(body,"tenantId"),user=text(body,"targetUserId"),identity=text(body,"identityId"),digest=text(body,"payloadDigest"),role=text(body,"role");
    uuid(tenant);uuid(user);uuid(identity);
    if(!digest.matches("[a-f0-9]{64}")||!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role))throw denied(400,"INVALID_REQUEST");
    long fence;
    try { String raw=text(body,"fencingToken");if(!raw.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(raw); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    String raw=text(body,"adminCandidates");
    if(raw.length()>74000)throw denied(400,"INVALID_REQUEST");
    List<String> pairs=raw.isEmpty()?List.of():Arrays.stream(raw.split(",",-1)).sorted().toList();
    if(pairs.size()>1000||pairs.stream().distinct().count()!=pairs.size())throw denied(400,"INVALID_REQUEST");
    List<Candidate> admins=pairs.stream().map(pair->{
      String[] values=pair.split(":",-1);
      if(values.length!=2)throw denied(400,"INVALID_REQUEST");
      uuid(values[0]);uuid(values[1]);return new Candidate(values[0],values[1]);
    }).toList();
    if(admins.stream().map(Candidate::userId).distinct().count()!=admins.size()
      ||admins.stream().map(Candidate::identityId).distinct().count()!=admins.size())throw denied(400,"INVALID_REQUEST");
    return new Command(tenant,user,identity,digest,fence,role,admins,String.join(",",pairs));
  }

  private boolean identityMatches(Binding binding,String tenantId,String userId,UserModel user,String role) {
    if(user==null||user.getServiceAccountClientLink()!=null)return false;
    String classification=user.getFirstAttribute("dc_identity_class");
    if(classification!=null&&!"TENANT_USER".equals(classification))return false;
    if((user.getFirstAttribute("tenant_id")!=null&&!tenantId.equals(user.getFirstAttribute("tenant_id")))
      ||(user.getFirstAttribute("dc_user_id")!=null&&!userId.equals(user.getFirstAttribute("dc_user_id")))
      ||(user.getFirstAttribute("tenant_slug")!=null&&!binding.organization().getAlias().equals(user.getFirstAttribute("tenant_slug"))))return false;
    boolean classified="TENANT_USER".equals(user.getFirstAttribute("dc_identity_class"))
      &&tenantId.equals(user.getFirstAttribute("tenant_id"))&&userId.equals(user.getFirstAttribute("dc_user_id"))
      &&binding.organization().getAlias().equals(user.getFirstAttribute("tenant_slug"));
    String bootstrap=binding.client().getAttribute("dc_verified_bootstrap_admins");
    boolean enrolled="ADMIN".equals(role)&&bootstrap!=null
      &&Arrays.asList(bootstrap.split(",")).contains(userId+":"+user.getId());
    if(!classified&&!enrolled)return false;
    var desired=binding.realm().getRole(role.toLowerCase(java.util.Locale.ROOT));
    if(desired==null||desired.isComposite()||!user.hasRole(desired))return false;
    if(user.getRoleMappingsStream().anyMatch(grant->grant.getName().startsWith("platform_")
      ||Set.of("create-realm","realm-admin").contains(grant.getName())
      ||(Set.of("agent","supervisor","admin").contains(grant.getName())&&!grant.getId().equals(desired.getId()))))return false;
    if(binding.realm().getRolesStream().filter(grant->grant.getName().startsWith("platform_")
      ||Set.of("create-realm","realm-admin").contains(grant.getName())
      ||(Set.of("agent","supervisor","admin").contains(grant.getName())&&!grant.getId().equals(desired.getId()))).anyMatch(user::hasRole))return false;
    var management=session.clients().getClientByClientId(binding.realm(),"realm-management");
    if(management!=null&&management.getRolesStream().anyMatch(user::hasRole))return false;
    var memberships=session.getProvider(OrganizationProvider.class).getByMember(user).toList();
    return memberships.size()==1&&memberships.get(0).getId().equals(binding.organization().getId());
  }

  private boolean usableAdmin(Binding binding,Command command,Candidate candidate) {
    if(candidate.userId().equals(command.userId())||candidate.identityId().equals(command.identityId()))return false;
    UserModel user=UserStoragePrivateUtil.userLocalStorage(session).getUserById(binding.realm(),candidate.identityId());
    if(!identityMatches(binding,command.tenantId(),candidate.userId(),user,"ADMIN")||!user.isEnabled()
      ||!identityEnabled(binding,candidate.identityId())
      ||!user.isEmailVerified()||user.getRequiredActionsStream().findAny().isPresent())return false;
    var credentials=user.credentialManager().getStoredCredentialsStream().toList();
    return credentials.stream().anyMatch(credential->"password".equals(credential.getType()))
      &&credentials.stream().filter(credential->"otp".equals(credential.getType()))
        .anyMatch(credential->"totp".equals(OTPCredentialModel.createFromCredentialModel(credential).getOTPCredentialData().getSubType()));
  }

  private boolean identityEnabled(Binding binding,String identityId) {
    var manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    var rows=manager.createNativeQuery("SELECT ENABLED FROM USER_ENTITY WHERE REALM_ID=:realm AND ID=:identity")
      .setParameter("realm",binding.realm().getId()).setParameter("identity",identityId).getResultList();
    return rows.size()==1&&Boolean.TRUE.equals(rows.get(0));
  }

  private Response outcome(Binding binding,PeopleOperation operation,PeopleReceipt proof) {
    if(proof==null)return json(200,Map.of("outcome","UNKNOWN"));
    if("SUCCEEDED".equals(proof.outcome)) {
      UserModel user=UserStoragePrivateUtil.userLocalStorage(session).getUserById(binding.realm(),proof.identityId);
      if(user==null||user.isEnabled()||identityEnabled(binding,proof.identityId)||session.sessions().getUserSessionsStream(binding.realm(),user).findAny().isPresent()
        ||session.sessions().getOfflineUserSessionsStream(binding.realm(),user).findAny().isPresent())
        return json(200,Map.of("outcome","UNKNOWN"));
    }
    return json(200,Map.of("version",1,"outcome",proof.outcome,"receiptRef",proof.id,"reasonCode",proof.reasonCode,
      "tenantId",operation.tenantId,"operationId",operation.operationId,"userId",operation.targetUserId,
      "payloadDigest",operation.payloadDigest,"identityId",proof.identityId));
  }

  @POST @Path("check") @Consumes(MediaType.APPLICATION_JSON)
  public Response check(Map<String,Object> body) {
    Command command=parse(body);
    Binding binding=authority.authorize(command.tenantId());
    if(!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(command.role()))throw denied(403,"FORBIDDEN");
    EntityManager manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    authority.lockTenant(manager,binding,command.tenantId());
    UserModel user=UserStoragePrivateUtil.userLocalStorage(session).getUserById(binding.realm(),command.identityId());
    String reason="READY";
    if(!identityMatches(binding,command.tenantId(),command.userId(),user,command.role()))reason="PROTECTED_OR_FOREIGN_IDENTITY";
    else if(!user.isEnabled()||!identityEnabled(binding,command.identityId()))reason="IDENTITY_STATE_CONFLICT";
    else if("ADMIN".equals(command.role())&&command.admins().stream().noneMatch(candidate->usableAdmin(binding,command,candidate)))reason="LAST_USABLE_ADMIN";
    return json(200,Map.of("version",1,"outcome","READY".equals(reason)?"READY":"REJECTED","reasonCode",reason,
      "tenantId",command.tenantId(),"userId",command.userId(),"identityId",command.identityId(),"payloadDigest",command.digest()));
  }

  @POST @Path("{operationId}") @Consumes(MediaType.APPLICATION_JSON)
  public Response disable(@PathParam("operationId") String operationId,Map<String,Object> body) {
    Command command=parse(body);uuid(operationId);
    Binding binding=authority.authorize(command.tenantId());
    if(!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(command.role()))throw denied(403,"FORBIDDEN");
    EntityManager manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    authority.lockTenant(manager,binding,command.tenantId());
    String key=authority.operationKey(binding,operationId);
    String fingerprint=hash(String.join("\n","DISABLE_ACCOUNT",command.tenantId(),command.userId(),command.identityId(),command.digest(),command.role(),command.canonicalAdmins(),binding.organization().getId()));
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation!=null&&(!fingerprint.equals(operation.requestDigest)||!command.digest().equals(operation.payloadDigest)))throw denied(409,"CORRELATION_CONFLICT");
    if(operation==null) {
      operation=new PeopleOperation();operation.id=key;operation.realmId=binding.realm().getId();operation.clientId=binding.client().getId();
      operation.operationId=operationId;operation.tenantId=command.tenantId();operation.targetUserId=command.userId();
      operation.payloadDigest=command.digest();operation.requestDigest=fingerprint;operation.maxFence=command.fence();manager.persist(operation);
    }
    if(command.fence()<operation.maxFence)throw denied(409,"STALE_FENCE");
    operation.maxFence=command.fence();
    String receiptId=hash(key+":DISABLE_ACCOUNT:0");
    PeopleReceipt previous=manager.find(PeopleReceipt.class,receiptId);
    if(previous!=null)return outcome(binding,operation,previous);
    var identities=new java.util.TreeSet<String>();identities.add(command.identityId());
    command.admins().forEach(candidate->identities.add(candidate.identityId()));
    manager.createNativeQuery("SELECT ID FROM USER_ENTITY WHERE REALM_ID=:realm AND ID IN (:ids) ORDER BY ID FOR UPDATE")
      .setParameter("realm",binding.realm().getId()).setParameter("ids",identities).getResultList();
    UserModel user=UserStoragePrivateUtil.userLocalStorage(session).getUserById(binding.realm(),command.identityId());
    String rejection=null;
    if(!identityMatches(binding,command.tenantId(),command.userId(),user,command.role()))rejection="PROTECTED_OR_FOREIGN_IDENTITY";
    else if(!user.isEnabled()||!identityEnabled(binding,command.identityId()))rejection="IDENTITY_STATE_CONFLICT";
    else if("ADMIN".equals(command.role())&&command.admins().stream().noneMatch(candidate->usableAdmin(binding,command,candidate)))rejection="LAST_USABLE_ADMIN";
    PeopleReceipt proof=new PeopleReceipt();proof.id=receiptId;proof.operationKey=key;proof.step="DISABLE_ACCOUNT";proof.generation=0;proof.identityId=command.identityId();
    proof.outcome=rejection==null?"SUCCEEDED":"REJECTED_NO_EFFECT";proof.reasonCode=rejection==null?"DISABLED":rejection;
    try {
      if(rejection==null) {
        session.users().getUserById(binding.realm(),command.identityId()).setEnabled(false);
        session.sessions().removeUserSessions(binding.realm(),user);
        session.sessions().getOfflineUserSessionsStream(binding.realm(),user).toList()
          .forEach(offline->session.sessions().removeOfflineUserSession(binding.realm(),offline));
      }
      manager.persist(proof);manager.flush();
      return outcome(binding,operation,proof);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();throw denied(503,"IDENTITY_OUTCOME_UNKNOWN");
    }
  }

  @GET @Path("{operationId}")
  public Response read(@PathParam("operationId") String operationId,@QueryParam("tenantId") String tenantId,
    @QueryParam("targetUserId") String target,@QueryParam("payloadDigest") String digest) {
    uuid(operationId);uuid(tenantId);uuid(target);
    if(digest==null||!digest.matches("[a-f0-9]{64}"))throw denied(400,"INVALID_REQUEST");
    Binding binding=authority.authorize(tenantId);
    EntityManager manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    String key=authority.operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)return json(200,Map.of("outcome","UNKNOWN"));
    if(!tenantId.equals(operation.tenantId)||!target.equals(operation.targetUserId)||!digest.equals(operation.payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    return outcome(binding,operation,manager.find(PeopleReceipt.class,hash(key+":DISABLE_ACCOUNT:0")));
  }
}
