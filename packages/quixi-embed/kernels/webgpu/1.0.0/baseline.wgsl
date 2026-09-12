// Arctic XS graph v1. FP32 baseline; no optional features or approximated tanh GELU.
struct Params { tokens:u32, batch:u32, input_width:u32, output_width:u32,
  weight:u32, bias:u32, position:u32, token_type:u32 };
@group(0) @binding(0) var<storage,read> weights:array<f32>;
@group(0) @binding(1) var<storage,read> x:array<f32>;
@group(0) @binding(2) var<storage,read> y:array<f32>;
@group(0) @binding(3) var<storage,read> z:array<f32>;
@group(0) @binding(4) var<storage,read_write> result:array<f32>;
@group(0) @binding(5) var<storage,read> ids:array<u32>;
@group(0) @binding(6) var<storage,read> mask:array<u32>;
@group(0) @binding(7) var<uniform> p:Params;
var<workgroup> reduction:array<f32,128>;

@compute @workgroup_size(64)
fn gather(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x+g.y*4194240u; if(i>=p.batch*p.tokens*384u){return;}
  let row=i/384u;let col=i%384u;
  result[i]=(weights[p.weight+ids[row]*384u+col]+weights[p.token_type+col])+
    weights[p.position+(row%p.tokens)*384u+col];
}

@compute @workgroup_size(64)
fn linear(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x+g.y*4194240u;if(i>=p.batch*p.tokens*p.output_width){return;}
  let row=i/p.output_width;let col=i%p.output_width;
  var sums=vec4f(0.0);
  for(var k=0u;k<p.input_width;k+=4u){
    let a=row*p.input_width+k;let b=p.weight+col*p.input_width+k;
    sums+=vec4f(x[a],x[a+1u],x[a+2u],x[a+3u])*vec4f(weights[b],weights[b+1u],weights[b+2u],weights[b+3u]);
  }
  result[i]=((sums.x+sums.y)+(sums.z+sums.w))+weights[p.bias+col];
}

@compute @workgroup_size(64)
fn add(@builtin(global_invocation_id) g:vec3u){
  let i=g.x+g.y*4194240u;if(i<p.batch*p.tokens*384u){result[i]=x[i]+y[i];}
}

@compute @workgroup_size(128)
fn norm(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let row=group.x;let base=row*384u;
  reduction[lane]=x[base+lane]+x[base+lane+128u]+x[base+lane+256u];
  workgroupBarrier();
  for(var step=64u;step>0u;step/=2u){if(lane<step){reduction[lane]+=reduction[lane+step];}workgroupBarrier();}
  let mean=reduction[0]/384.0;
  workgroupBarrier();
  let a=x[base+lane]-mean;let b=x[base+lane+128u]-mean;let c=x[base+lane+256u]-mean;
  reduction[lane]=a*a+b*b+c*c;workgroupBarrier();
  for(var step=64u;step>0u;step/=2u){if(lane<step){reduction[lane]+=reduction[lane+step];}workgroupBarrier();}
  let inverse=inverseSqrt(reduction[0]/384.0+1e-12);
  for(var j=lane;j<384u;j+=128u){result[base+j]=(x[base+j]-mean)*inverse*weights[p.weight+j]+weights[p.bias+j];}
}

@compute @workgroup_size(64)
fn scores(@builtin(global_invocation_id) g:vec3u){
  let key=g.x;let row=g.y;let bh=g.z;
  if(key>=p.tokens||row>=p.tokens){return;}
  let batch=bh/12u;let head=bh%12u;
  let at=((batch*12u+head)*p.tokens+row)*p.tokens+key;
  if(mask[batch*p.tokens+key]==0u){result[at]=-3.402823466e38;return;}
  let a=(batch*p.tokens+row)*384u+head*32u;let b=(batch*p.tokens+key)*384u+head*32u;
  var sums=vec4f(0.0);
  for(var k=0u;k<32u;k+=4u){sums+=vec4f(x[a+k],x[a+k+1u],x[a+k+2u],x[a+k+3u])*vec4f(y[b+k],y[b+k+1u],y[b+k+2u],y[b+k+3u]);}
  result[at]=((sums.x+sums.y)+(sums.z+sums.w))*0.17677669529663687;
}

@compute @workgroup_size(128)
fn softmax(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let base=(group.x+group.y*p.batch*p.tokens)*p.tokens;
  var maximum=-3.402823466e38;
  for(var k=lane;k<p.tokens;k+=128u){maximum=max(maximum,result[base+k]);}
  reduction[lane]=maximum;workgroupBarrier();
  for(var step=64u;step>0u;step/=2u){if(lane<step){reduction[lane]=max(reduction[lane],reduction[lane+step]);}workgroupBarrier();}
  maximum=reduction[0];workgroupBarrier();
  var sum=0.0;for(var k=lane;k<p.tokens;k+=128u){let e=exp(result[base+k]-maximum);result[base+k]=e;sum+=e;}
  reduction[lane]=sum;workgroupBarrier();
  for(var step=64u;step>0u;step/=2u){if(lane<step){reduction[lane]+=reduction[lane+step];}workgroupBarrier();}
  let total=reduction[0];for(var k=lane;k<p.tokens;k+=128u){result[base+k]/=total;}
}

@compute @workgroup_size(64)
fn context(@builtin(global_invocation_id) g:vec3u){
  let i=g.x+g.y*4194240u;if(i>=p.batch*p.tokens*384u){return;}
  let col=i%384u;let row=(i/384u)%p.tokens;let batch=i/(384u*p.tokens);
  let head=col/32u;let base=((batch*12u+head)*p.tokens+row)*p.tokens;
  var sum=0.0;for(var k=0u;k<p.tokens;k++){sum+=x[base+k]*y[(batch*p.tokens+k)*384u+col];}
  result[i]=sum;
}

// Abramowitz-Stegun 7.1.26 evaluates erf, max approximation error <1.5e-7.
// This is a numerical implementation of erf, not the different tanh GELU graph.
fn erf_value(value:f32)->f32{
  let t=1.0/(1.0+0.3275911*abs(value));
  let polynomial=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t;
  return sign(value)*(1.0-polynomial*exp(-value*value));
}
@compute @workgroup_size(64)
fn gelu(@builtin(global_invocation_id) g:vec3u){
  let i=g.x+g.y*4194240u;if(i<p.batch*p.tokens*1536u){let value=result[i];result[i]=value*0.5*(1.0+erf_value(value*0.7071067811865475244));}
}

@compute @workgroup_size(128)
fn pool(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let base=group.x*p.tokens*384u;
  let a=x[base+lane];let b=x[base+lane+128u];let c=x[base+lane+256u];
  reduction[lane]=a*a+b*b+c*c;workgroupBarrier();
  for(var step=64u;step>0u;step/=2u){if(lane<step){reduction[lane]+=reduction[lane+step];}workgroupBarrier();}
  let magnitude=max(sqrt(reduction[0]),1e-12);
  for(var j=lane;j<384u;j+=128u){result[group.x*384u+j]=x[base+j]/magnitude;}
}
