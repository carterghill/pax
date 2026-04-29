import com.android.build.api.dsl.ApplicationExtension
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.get

const val TASK_GROUP = "rust"

open class Config {
    lateinit var rootDirRel: String
}

open class RustPlugin : Plugin<Project> {
    private lateinit var config: Config

    override fun apply(project: Project) = with(project) {
        config = extensions.create("rust", Config::class.java)

        // ── Pax Android Rust targets ───────────────────────────────────────────
        //
        // LiveKit publishes libwebrtc bins for android arm / arm64 / x86_64 only — NO i686
        // (`webrtc-android-i686-*` zip does not exist → webrtc-sys 404 during download).
        //
        // Gradle product flavor names must be valid identifiers and must match AGP's task naming
        // (`merge{Name}DebugJniLibFolders`). Using `x86_64` as a flavor confused that mapping
        // versus the historic `x86` flavor — use plain `x8664` instead (same NDK ABI: x86_64).
        //
        // Use **namespaced keys** (`pax.rust.*`) so we never clash with stray global Gradle props
        // like `archList`/`targetList` defined in ~/.gradle/gradle.properties.
        //
        // Defaults: rustc short targets + parallel Gradle flavors + one NDK ABI per flavor.
        val defaultAbiList = listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        val defaultRustTargets = listOf("aarch64", "armv7", "x86_64")
        // Deliberately not `x86_64`: avoids underscore-vs-task-name quirks; rustc target stays `x86_64`.
        val defaultGradleFlavors = listOf("arm64", "arm", "x8664")

        fun parseCsv(prop: Any?): List<String>? =
            (prop as? String)
                ?.split(',')
                ?.map { it.trim() }
                ?.filter { it.isNotEmpty() }

        val abiList = parseCsv(findProperty("pax.rust.abis")) ?: defaultAbiList
        val rustTargets = parseCsv(findProperty("pax.rust.targets")) ?: defaultRustTargets
        val gradleFlavors =
            parseCsv(findProperty("pax.rust.flavors"))
                ?: defaultGradleFlavors

        require(rustTargets.size == gradleFlavors.size && rustTargets.size == abiList.size) {
            "pax.rust.{targets,flavors,abis} must contain the same number of comma-separated entries " +
                "(got targets=${rustTargets.size}, flavors=${gradleFlavors.size}, abis=${abiList.size})."
        }

        extensions.configure<ApplicationExtension> {
            @Suppress("UnstableApiUsage")
            flavorDimensions.add("abi")
            productFlavors {
                create("universal") {
                    dimension = "abi"
                    ndk {
                        abiFilters += abiList
                    }
                }
                gradleFlavors.forEachIndexed { index, flavorName ->
                    create(flavorName) {
                        dimension = "abi"
                        ndk {
                            abiFilters.add(abiList[index])
                        }
                    }
                }
            }
        }

        afterEvaluate {
            for (profile in listOf("debug", "release")) {
                val profileCapitalized = profile.replaceFirstChar { it.uppercase() }
                val buildTask =
                    tasks.maybeCreate(
                        "rustBuildUniversal$profileCapitalized",
                        DefaultTask::class.java,
                    ).apply {
                        group = TASK_GROUP
                        description = "Build dynamic library in $profile mode for all targets"
                    }

                tasks["mergeUniversal${profileCapitalized}JniLibFolders"].dependsOn(buildTask)

                for ((index, rustcTarget) in rustTargets.withIndex()) {
                    val gradleFlavor = gradleFlavors[index]
                    // AGP PascalCase variant prefix: arm64→Arm64, arm→Arm, x8664→X8664
                    val variantPrefix = gradleFlavor.replaceFirstChar { it.uppercaseChar() }

                    val targetBuildTask =
                        project.tasks.maybeCreate(
                            "rustBuild$variantPrefix$profileCapitalized",
                            BuildTask::class.java,
                        ).apply {
                            group = TASK_GROUP
                            description = "Build dynamic library in $profile mode for Gradle flavor $gradleFlavor (rustc=$rustcTarget)"
                            rootDirRel = config.rootDirRel
                            target = rustcTarget
                            release = profile == "release"
                        }

                    buildTask.dependsOn(targetBuildTask)

                    val mergeTask =
                        tasks.findByName(
                            "merge${variantPrefix}${profileCapitalized}JniLibFolders",
                        )
                            ?: throw GradleException(
                                "RustPlugin: JNI merge task merge${variantPrefix}${profileCapitalized}JniLibFolders "
                                    + "not found — check Gradle product flavor name <$gradleFlavor> vs AGP naming."
                            )

                    mergeTask.dependsOn(targetBuildTask)
                }
            }
        }
    }
}
