# Akamai-VM
A decompiler for Akamai's stack-based virtual machine

Akamai is an antibot used on a number of websites, the sample I got this from was `hilton.com`.

# How Does This VM Work?

Akamai's VM works by operating with stack-based memory- pushing/popping values 

This VM was quite a simple architecture, nothing too fancy, so writing a decompiler only took about ~2 days of work
- Day 1:
  - Mostly some debugging, having a look around how the VM functions
  - Found & implimented logic for opcodes
  - Got a decent understanding of the VM via tracing
- Day 2:
  - Began to write a lifter for the VM
  - Wrote base-decompilation logic (CFG/structuring)
  - Implimented passes for emitting clean code (Inlining/collapsing)

# Challenges

As I did say before, the VM wasn't crazy, and has a fairly basic design, however, it did have a couple things that made it a bit more unique than other VMs

- Property resolving - memory system 
  - The VM stored a value in a property
  - The value set at that property can be accessed at any point
  - The opcode runs down the stack and once it finds the value that has the property name, it stops
  - It then retrieves the value of the property and pushes it
- Non-existent calls
  - The VM would call a non-existent opcode to exit
  - In this sample, that was opcode `6`
  - The main loop was wrapping opcode calls in a `try/catch` block, but did nothing upon catching
  - Doesn't handle errors because it has its own opcode for error handling, this one is only meant to excuse
 
# Notice

- The information, files, & content in this repo is for **educational & research purposes**
- If you believe any information in this repo is false, please make an issue
- This is current at the time of posting (`12 May, 2026`)
- This is a static decompiler- no parsing has been included as the intention of this repo serves to provide information on decompilation techniques I have used

# Contact

Contact is available via *Telegram* or *email*
- Telegram - `@Fyxavwfunctionstringstring`
- Email - `alana72212@proton.me`

# Legal / DMCA

⚠️I am fully compliant with any takedown request by the order of Akamai Technologies, or associated parties⚠️
