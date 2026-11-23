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
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.OTPCredentialModel;
import org.keycloak.storage.UserStoragePrivateUtil;
import static io.dcontact.keycloak.people.PeopleResource.*;

/**
 * #998: แก้ชื่อที่แสดง (UPDATE_PROFILE) และเปิดบัญชีที่ปิดแล้วกลับ (ENABLE_ACCOUNT) ตาม ADR-035
 * ใช้ tenant gate, operation fence และ immutable receipt เดียวกับ disable; mutation กับ receipt อยู่ใน transaction เดียวกัน
 * ไม่ตั้ง password/TOTP แทนผู้ใช้ ไม่เปลี่ยน role/Organization/email และไม่ adopt identity จาก lookup
 */
@Produces(MediaType.APPLICATION_JSON)
public class PeopleAccountResource {
  private static final Set<String> STEPS=Set.of("UPDATE_PROFILE","ENABLE_ACCOUNT");
  private static final Set<String> COMMON=Set.of("tenantId","targetUserId","identityId","payloadDigest","fencingToken","role");
  private static final Pattern CONTROL=Pattern.compile("[\\p{Cc}\\p{Cf}]");
  private final KeycloakSession session;
  private final PeopleResource authority;
  private final PeopleDisableResource identities;

  PeopleAccountResource(KeycloakSession session,PeopleResource authority) {
    this.session=session;this.authority=authority;this.identities=new PeopleDisableResource(session,authority);
  }

  /** displayName มีเฉพาะ POST ของ UPDATE_PROFILE; nameDigest (SHA-256) ใช้ใน descriptor และ GET เพื่อไม่ให้ชื่ออยู่ใน URL */
  private record Command(String step,String tenantId,String userId,String identityId,String digest,long fence,String role,String displayName,String nameDigest) {}

  private static String step(String value) {
    if(value==null||!STEPS.contains(value))throw denied(404,"NOT_FOUND");
    return value;
  }

  private static String text(Map<String,Object> body,String name) {
    Object value=body.get(name);
    if(!(value instanceof String))throw denied(400,"INVALID_REQUEST");
    return (String)value;
  }

  private static void displayName(String name) {
    if(name==null||name.codePointCount(0,name.length())<1||name.codePointCount(0,name.length())>120||CONTROL.matcher(name).find()
      ||!name.equals(name.strip().replaceAll("\\s+"," ")))throw denied(400,"INVALID_REQUEST");
  }

  private static void common(String tenant,String user,String identity,String digest,String role) {
    uuid(tenant);uuid(user);uuid(identity);
    if(digest==null||!digest.matches("[a-f0-9]{64}")||role==null||!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role))throw denied(400,"INVALID_REQUEST");
  }

  private Command parse(String step,Map<String,Object> body) {
    var fields=new java.util.HashSet<>(COMMON);
    if("UPDATE_PROFILE".equals(step))fields.add("displayName");
    if(body==null||!body.keySet().equals(fields))throw denied(400,"INVALID_REQUEST");
    String tenant=text(body,"tenantId"),user=text(body,"targetUserId"),identity=text(body,"identityId"),digest=text(body,"payloadDigest"),role=text(body,"role");
    common(tenant,user,identity,digest,role);
    long fence;
    try { String raw=text(body,"fencingToken");if(!raw.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(raw); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    String name=null;
    if("UPDATE_PROFILE".equals(step)) { name=text(body,"displayName");displayName(name); }
    return new Command(step,tenant,user,identity,digest,fence,role,name,name==null?"":hash(name));
  }

  private String fingerprint(Binding binding,Command command) {
    return hash(String.join("\n",command.step(),command.tenantId(),command.userId(),command.identityId(),command.digest(),command.role(),
      command.nameDigest(),binding.organization().getId()));
  }

  /** ผู้ใช้ตั้ง password และ TOTP เองแล้ว ยืนยัน email และไม่มี required action ค้าง (เกณฑ์เดียวกับ activation probe) */
  private boolean credentialsReady(UserModel user) {
    if(!user.isEmailVerified()||user.getRequiredActionsStream().findAny().isPresent())return false;
    var credentials=user.credentialManager().getStoredCredentialsStream().toList();
    return credentials.stream().anyMatch(credential->"password".equals(credential.getType()))
      &&credentials.stream().filter(credential->"otp".equals(credential.getType()))
        .anyMatch(credential->"totp".equals(OTPCredentialModel.createFromCredentialModel(credential).getOTPCredentialData().getSubType()));
  }

  private UserModel local(Binding binding,String identityId) {
    return UserStoragePrivateUtil.userLocalStorage(session).getUserById(binding.realm(),identityId);
  }

  /** เหตุผลที่ปฏิเสธก่อนแตะ identity หรือ null เมื่อพร้อม; อ่านจาก local JPA provider ไม่ใช่ cached UserModel */
  private String rejection(Binding binding,Command command) {
    UserModel user=local(binding,command.identityId());
    if(!identities.identityMatches(binding,command.tenantId(),command.userId(),user,command.role()))return "PROTECTED_OR_FOREIGN_IDENTITY";
    boolean enabled=user.isEnabled()&&identities.identityEnabled(binding,command.identityId());
    if("UPDATE_PROFILE".equals(command.step()))return enabled?null:"IDENTITY_STATE_CONFLICT";
    if(enabled||user.isEnabled()||identities.identityEnabled(binding,command.identityId()))return "IDENTITY_STATE_CONFLICT";
    return credentialsReady(user)?null:"CREDENTIALS_NOT_READY";
  }

  private void allowedRole(Binding binding,String role) {
    if(!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(role))throw denied(403,"FORBIDDEN");
  }

  private String receiptId(String key,String step) { return hash(key+":"+step+":0"); }

  private Response outcome(Binding binding,PeopleOperation operation,Command command,PeopleReceipt proof) {
    if(proof==null)return json(200,Map.of("outcome","UNKNOWN"));
    if("SUCCEEDED".equals(proof.outcome)) {
      // receipt สำเร็จต้อง readback ว่าสถานะจริงยังตรง: drift หลัง receipt คืน UNKNOWN ไม่คืน marker เก่า
      UserModel user=local(binding,proof.identityId);
      boolean matches=identities.identityMatches(binding,operation.tenantId,operation.targetUserId,user,command.role());
      boolean current="UPDATE_PROFILE".equals(command.step())
        ?matches&&user.getFirstName()!=null&&command.nameDigest().equals(hash(user.getFirstName()))
        :matches&&user.isEnabled()&&identities.identityEnabled(binding,proof.identityId)&&credentialsReady(user);
      if(!current)return json(200,Map.of("outcome","UNKNOWN"));
    }
    return json(200,Map.of("version",1,"outcome",proof.outcome,"receiptRef",proof.id,"reasonCode",proof.reasonCode,
      "tenantId",operation.tenantId,"operationId",operation.operationId,"userId",operation.targetUserId,
      "payloadDigest",operation.payloadDigest,"identityId",proof.identityId));
  }

  @POST @Path("{step}/check") @Consumes(MediaType.APPLICATION_JSON)
  public Response check(@PathParam("step") String rawStep,Map<String,Object> body) {
    Command command=parse(step(rawStep),body);
    Binding binding=authority.authorize(command.tenantId());
    allowedRole(binding,command.role());
    EntityManager manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    authority.lockTenant(manager,binding,command.tenantId());
    String reason=rejection(binding,command);
    return json(200,Map.of("version",1,"outcome",reason==null?"READY":"REJECTED","reasonCode",reason==null?"READY":reason,
      "tenantId",command.tenantId(),"userId",command.userId(),"identityId",command.identityId(),"payloadDigest",command.digest()));
  }

  @POST @Path("{step}/{operationId}") @Consumes(MediaType.APPLICATION_JSON)
  public Response mutate(@PathParam("step") String rawStep,@PathParam("operationId") String operationId,Map<String,Object> body) {
    Command command=parse(step(rawStep),body);uuid(operationId);
    Binding binding=authority.authorize(command.tenantId());
    allowedRole(binding,command.role());
    EntityManager manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    authority.lockTenant(manager,binding,command.tenantId());
    String key=authority.operationKey(binding,operationId),fingerprint=fingerprint(binding,command);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation!=null&&(!fingerprint.equals(operation.requestDigest)||!command.digest().equals(operation.payloadDigest)))throw denied(409,"CORRELATION_CONFLICT");
    if(operation==null) {
      operation=new PeopleOperation();operation.id=key;operation.realmId=binding.realm().getId();operation.clientId=binding.client().getId();
      operation.operationId=operationId;operation.tenantId=command.tenantId();operation.targetUserId=command.userId();
      operation.payloadDigest=command.digest();operation.requestDigest=fingerprint;operation.maxFence=command.fence();manager.persist(operation);
    }
    if(command.fence()<operation.maxFence)throw denied(409,"STALE_FENCE");
    operation.maxFence=command.fence();
    String receiptId=receiptId(key,command.step());
    PeopleReceipt previous=manager.find(PeopleReceipt.class,receiptId);
    if(previous!=null)return outcome(binding,operation,command,previous);
    // ล็อกแถว identity ก่อนตรวจ เพื่อไม่ให้การแก้ enabled/ชื่อจากทางอื่นแข่งผ่าน guard
    manager.createNativeQuery("SELECT ID FROM USER_ENTITY WHERE REALM_ID=:realm AND ID=:id FOR UPDATE")
      .setParameter("realm",binding.realm().getId()).setParameter("id",command.identityId()).getResultList();
    String reason=rejection(binding,command);
    PeopleReceipt proof=new PeopleReceipt();proof.id=receiptId;proof.operationKey=key;proof.step=command.step();proof.generation=0;proof.identityId=command.identityId();
    proof.outcome=reason==null?"SUCCEEDED":"REJECTED_NO_EFFECT";
    proof.reasonCode=reason!=null?reason:"UPDATE_PROFILE".equals(command.step())?"PROFILE_UPDATED":"ENABLED";
    try {
      if(reason==null) {
        UserModel user=session.users().getUserById(binding.realm(),command.identityId());
        if("UPDATE_PROFILE".equals(command.step()))user.setFirstName(command.displayName());
        else user.setEnabled(true);
      }
      manager.persist(proof);manager.flush();
      return outcome(binding,operation,command,proof);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();throw denied(503,"IDENTITY_OUTCOME_UNKNOWN");
    }
  }

  @GET @Path("{step}/{operationId}")
  public Response read(@PathParam("step") String rawStep,@PathParam("operationId") String operationId,@QueryParam("tenantId") String tenantId,
    @QueryParam("targetUserId") String target,@QueryParam("identityId") String identityId,@QueryParam("payloadDigest") String digest,
    @QueryParam("role") String role,@QueryParam("displayNameDigest") String nameDigest) {
    String step=step(rawStep);uuid(operationId);common(tenantId,target,identityId,digest,role);
    if("UPDATE_PROFILE".equals(step)) { if(nameDigest==null||!nameDigest.matches("[a-f0-9]{64}"))throw denied(400,"INVALID_REQUEST"); }
    else if(nameDigest!=null)throw denied(400,"INVALID_REQUEST");
    Command command=new Command(step,tenantId,target,identityId,digest,1,role,null,nameDigest==null?"":nameDigest);
    Binding binding=authority.authorize(tenantId);
    EntityManager manager=session.getProvider(JpaConnectionProvider.class).getEntityManager();
    String key=authority.operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)return json(200,Map.of("outcome","UNKNOWN"));
    if(!tenantId.equals(operation.tenantId)||!target.equals(operation.targetUserId)||!digest.equals(operation.payloadDigest)
      ||!fingerprint(binding,command).equals(operation.requestDigest))throw denied(409,"CORRELATION_CONFLICT");
    return outcome(binding,operation,command,manager.find(PeopleReceipt.class,receiptId(key,step)));
  }
}
