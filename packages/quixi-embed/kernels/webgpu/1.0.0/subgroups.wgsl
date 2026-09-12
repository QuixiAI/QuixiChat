// Optional subgroup reduction; supports varying subgroup sizes without a hardware width assumption.
// Appended to baseline.wgsl with `enable subgroups;` only on an explicitly enabled device.
@compute @workgroup_size(128)
fn norm_subgroup(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32,
  @builtin(subgroup_invocation_id) subgroup_lane:u32,@builtin(subgroup_id) subgroup:u32,
  @builtin(num_subgroups) groups:u32){
  let base=group.x*384u;
  let total=subgroupAdd(x[base+lane]+x[base+lane+128u]+x[base+lane+256u]);
  if(subgroup_lane==0u){reduction[subgroup]=total;}
  workgroupBarrier();
  var sum=0.0;for(var i=0u;i<groups;i++){sum+=reduction[i];}
  let mean=sum/384.0;
  workgroupBarrier();
  let a=x[base+lane]-mean;let b=x[base+lane+128u]-mean;let c=x[base+lane+256u]-mean;
  let variance=subgroupAdd(a*a+b*b+c*c);
  if(subgroup_lane==0u){reduction[subgroup]=variance;}
  workgroupBarrier();
  var squared=0.0;for(var i=0u;i<groups;i++){squared+=reduction[i];}
  let inverse=inverseSqrt(squared/384.0+1e-12);
  for(var j=lane;j<384u;j+=128u){result[base+j]=(x[base+j]-mean)*inverse*weights[p.weight+j]+weights[p.bias+j];}
}
