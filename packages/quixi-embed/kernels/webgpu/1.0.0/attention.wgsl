// Fused score/softmax/value path. One 64-lane workgroup owns one query/head.
// No global quadratic score tensor or layer readback. Head width is exactly 32.
var<workgroup> probabilities:array<f32,512>;
@compute @workgroup_size(64)
fn attention_fused(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let row=group.x;let head=group.y%12u;let batch=group.y/12u;
  let a=(batch*p.tokens+row)*384u+head*32u;
  var maximum=-3.402823466e38;
  for(var key=lane;key<p.tokens;key+=64u){
    let b=(batch*p.tokens+key)*384u+head*32u;var score=-3.402823466e38;
    if(mask[batch*p.tokens+key]!=0u){
      var sums=vec4f(0.0);
      for(var k=0u;k<32u;k+=4u){sums+=vec4f(x[a+k],x[a+k+1u],x[a+k+2u],x[a+k+3u])*vec4f(y[b+k],y[b+k+1u],y[b+k+2u],y[b+k+3u]);}
      score=((sums.x+sums.y)+(sums.z+sums.w))*0.17677669529663687;
    }
    probabilities[key]=score;maximum=max(maximum,score);
  }
  reduction[lane]=maximum;workgroupBarrier();
  for(var step=32u;step>0u;step/=2u){if(lane<step){reduction[lane]=max(reduction[lane],reduction[lane+step]);}workgroupBarrier();}
  maximum=reduction[0];workgroupBarrier();var sum=0.0;
  for(var key=lane;key<p.tokens;key+=64u){let value=exp(probabilities[key]-maximum);probabilities[key]=value;sum+=value;}
  reduction[lane]=sum;workgroupBarrier();
  for(var step=32u;step>0u;step/=2u){if(lane<step){reduction[lane]+=reduction[lane+step];}workgroupBarrier();}
  let total=reduction[0];
  for(var key=lane;key<p.tokens;key+=64u){probabilities[key]/=total;}
  workgroupBarrier();
  if(lane<32u){
    var value=0.0;for(var key=0u;key<p.tokens;key++){value+=probabilities[key]*z[(batch*p.tokens+key)*384u+head*32u+lane];}
    result[(batch*p.tokens+row)*384u+head*32u+lane]=value;
  }
}
