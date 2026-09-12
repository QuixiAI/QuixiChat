// Supplement, compiled with `enable f16;`. GPU conversion only; no JS packing kernel.
// Projections use FP16 weights/input tiles and products, with FP32 accumulation.
// LayerNorm, softmax, GELU, residuals, embedding gather and output remain FP32.
@group(0) @binding(8) var<storage,read_write> half_weights:array<f16>;
@compute @workgroup_size(64)
fn pack_weights(@builtin(global_invocation_id) g:vec3u){
  let i=g.x+g.y*4194240u;if(i<arrayLength(&half_weights)){half_weights[i]=f16(weights[i]);}
}
var<workgroup> half_x:array<f16,256>;
var<workgroup> half_w:array<f16,256>;
@compute @workgroup_size(8,8)
fn linear_half(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) local:vec3u){
  let row=group.y*16u+local.y*2u;let col=group.x*16u+local.x*2u;
  let lane=local.y*8u+local.x;var sums=vec4f(0.0);
  for(var base=0u;base<p.input_width;base+=16u){
    for(var j=lane;j<256u;j+=64u){
      let r=group.y*16u+j/16u;let c=group.x*16u+j/16u;let k=base+j%16u;
      half_x[j]=0.0h;half_w[j]=0.0h;
      if(r<p.batch*p.tokens){half_x[j]=f16(x[r*p.input_width+k]);}
      if(c<p.output_width){half_w[j]=half_weights[p.weight+c*p.input_width+k];}
    }
    workgroupBarrier();
    for(var k=0u;k<16u;k++){
      let a=vec2h(half_x[local.y*32u+k],half_x[local.y*32u+16u+k]);
      let b=vec2h(half_w[local.x*32u+k],half_w[local.x*32u+16u+k]);
      sums+=vec4f(vec4h(a.x*b.x,a.x*b.y,a.y*b.x,a.y*b.y));
    }
    workgroupBarrier();
  }
  if(row<p.batch*p.tokens){
    if(col<p.output_width){result[row*p.output_width+col]=sums.x+weights[p.bias+col];}
    if(col+1u<p.output_width){result[row*p.output_width+col+1u]=sums.y+weights[p.bias+col+1u];}
  }
  if(row+1u<p.batch*p.tokens){
    if(col<p.output_width){result[(row+1u)*p.output_width+col]=sums.z+weights[p.bias+col];}
    if(col+1u<p.output_width){result[(row+1u)*p.output_width+col+1u]=sums.w+weights[p.bias+col+1u];}
  }
}
