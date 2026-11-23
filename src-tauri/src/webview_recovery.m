#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// Wry owns its navigation delegate. Forward its navigation and download
// callbacks, and handle the renderer termination callback for the main view.
@interface PaxNavigationDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic, weak) id<WKNavigationDelegate> original;
@property(nonatomic) void (*onTermination)(void);
@end

@implementation PaxNavigationDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
    return self.original;
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)view {
    if ([self.original respondsToSelector:_cmd]) {
        [self.original webViewWebContentProcessDidTerminate:view];
    }
    self.onTermination();
}
@end

void pax_install_renderer_recovery(WKWebView *view, void (*onTermination)(void)) {
    static char delegateKey;
    PaxNavigationDelegate *delegate = [PaxNavigationDelegate new];
    delegate.original = view.navigationDelegate;
    delegate.onTermination = onTermination;
    objc_setAssociatedObject(view, &delegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.navigationDelegate = delegate;
}
